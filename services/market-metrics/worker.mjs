const MAX_BODY = 16 * 1024;
const MAX_BATCH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLUGIN_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

const ADD_EVENT = `
    INSERT INTO metric_events
      (channel, event_id, installation_id, plugin_id, kind, version, saved)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel, event_id) DO NOTHING
`;

function response(data, status = 200) {
    return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function knownChannel(channel) {
    return channel === "stable" || channel === "preview";
}

function hasKeys(value, ...keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validEvent(event) {
    if (typeof event?.event_id !== "string" || !UUID.test(event.event_id)
        || typeof event.plugin_id !== "string" || event.plugin_id.length > 64
        || !PLUGIN_ID.test(event.plugin_id)) {
        return false;
    }
    if (event.kind === "download") {
        return hasKeys(event, "kind", "event_id", "plugin_id", "version")
            && typeof event.version === "string" && event.version.length <= 32
            && VERSION.test(event.version)
            && event.version.split(".").every(part => Number(part) <= 0xffffffff);
    }
    return event.kind === "favorite" && hasKeys(event, "kind", "event_id", "plugin_id", "saved")
        && typeof event.saved === "boolean";
}

async function readEvents(request) {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        return response({ error: "expected_json" }, 415);
    }
    const reader = request.body?.getReader();
    if (!reader) return response({ error: "invalid_events" }, 400);
    const bytes = new Uint8Array(MAX_BODY);
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > MAX_BODY) {
                await reader.cancel();
                return response({ error: "body_too_large" }, 413);
            }
            bytes.set(value, size);
            size += value.byteLength;
        }
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
        if (!hasKeys(data, "channel", "installation_id", "events") || !knownChannel(data.channel)
            || typeof data.installation_id !== "string" || !UUID.test(data.installation_id)
            || !Array.isArray(data.events) || !data.events.length || data.events.length > MAX_BATCH
            || !data.events.every(validEvent)) {
            return response({ error: "invalid_events" }, 400);
        }
        return data;
    } catch {
        return response({ error: "invalid_json" }, 400);
    } finally {
        reader.releaseLock();
    }
}

async function counts(db, channel) {
    const { results } = await db.prepare(
        "SELECT plugin_id, downloads, favorites FROM metric_plugins WHERE channel = ?"
    ).bind(channel).all();
    return response({
        plugins: Object.fromEntries(results.map(({ plugin_id, downloads, favorites }) =>
            [plugin_id, { downloads, favorites }])),
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/stats") {
            if (request.method !== "GET") return response({ error: "method_not_allowed" }, 405);
            const channel = url.searchParams.get("channel");
            if (!knownChannel(channel)) return response({ error: "invalid_channel" }, 400);
            try {
                return await counts(env.DB, channel);
            } catch {
                return response({ error: "stats_unavailable" }, 503);
            }
        }

        if (url.pathname !== "/v1/events") return response({ error: "not_found" }, 404);
        if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
        const data = await readEvents(request);
        if (data instanceof Response) return data;

        // 一个批次事务执行，重试时已入库的事件不会再次触发计数变更。
        try {
            await env.DB.batch(data.events.map(event => env.DB.prepare(ADD_EVENT).bind(
                data.channel, event.event_id.toLowerCase(), data.installation_id.toLowerCase(),
                event.plugin_id, event.kind, event.version ?? null, event.saved === undefined ? null : Number(event.saved)
            )));
            return await counts(env.DB, data.channel);
        } catch (error) {
            const message = String(error);
            if (message.includes("market_rate_limited")) return response({ error: "rate_limited" }, 429);
            if (message.includes("FOREIGN KEY constraint failed")) return response({ error: "not_published" }, 422);
            return response({ error: "stats_unavailable" }, 503);
        }
    },
};
