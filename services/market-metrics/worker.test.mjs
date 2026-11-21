import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "./worker.mjs";

// 使用内置 SQLite 运行实际的迁移与 SQL。
function fixture(t) {
    const database = new DatabaseSync(":memory:");
    t.after(() => database.close());
    database.function("unixepoch", () => 1_700_000_000);
    for (const name of ["0001_metrics", "0002_published_plugins"]) {
        database.exec(readFileSync(new URL("./migrations/" + name + ".sql", import.meta.url), "utf8"));
    }
    const DB = {
        prepare(sql) {
            return {
                bind(...args) {
                    return {
                        run: () => database.prepare(sql).run(...args),
                        all: async () => ({ results: database.prepare(sql).all(...args) }),
                    };
                },
            };
        },
        async batch(statements) {
            database.exec("BEGIN IMMEDIATE");
            try {
                const results = statements.map(statement => statement.run());
                database.exec("COMMIT");
                return results;
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },
    };
    return {
        database,
        request: (path, options) => worker.fetch(new Request("https://metrics.example" + path, options), { DB }),
    };
}

const uuid = number => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
const download = event => ({ kind: "download", event_id: uuid(event), plugin_id: "example.payday", version: "1.0.1" });
const favorite = (event, saved) => ({ kind: "favorite", event_id: uuid(event), plugin_id: "example.payday", saved });

function submit(request, events, channel = "preview", installation = 1) {
    return request("/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, installation_id: uuid(installation), events }),
    });
}

async function payday(response, downloads, favorites) {
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).plugins["example.payday"], { downloads, favorites });
}

test("重复下载、并发批次和跨客户端收藏", async t => {
    const { request } = fixture(t);
    await payday(await submit(request, [download(10), download(10), favorite(11, true)]), 1, 1);
    const responses = await Promise.all([
        submit(request, [download(10), favorite(11, true)]),
        submit(request, [download(10), favorite(11, true)]),
    ]);
    for (const response of responses) await payday(response, 1, 1);
    await payday(await submit(request, [favorite(12, true)]), 1, 1);
    await payday(await submit(request, [favorite(13, true)], "preview", 2), 1, 2);
    await payday(await submit(request, [favorite(14, false)]), 1, 1);
    await payday(await submit(request, [favorite(11, true)]), 1, 1);
    await payday(await submit(request, [favorite(15, false)], "preview", 2), 1, 0);
});

test("频道隔离并保留历史上架版本", async t => {
    const { request, database } = fixture(t);
    const stable = await request("/v1/stats?channel=stable");
    assert.deepEqual(await stable.json(), { plugins: {} });
    database.exec(`
        INSERT INTO metric_plugins (channel, plugin_id) VALUES ('stable', 'example.payday');
        INSERT INTO metric_versions VALUES ('stable', 'example.payday', '1.0.1');
    `);
    await payday(await submit(request, [{ ...download(10), version: "1.0.0" }, favorite(11, true)]), 1, 1);
    await payday(await submit(request, [download(10)], "stable"), 1, 0);
    await payday(await request("/v1/stats?channel=preview"), 1, 1);
    await payday(await request("/v1/stats?channel=stable"), 1, 0);
});

test("拒绝未发布版本及无效请求且不产生部分计数", async t => {
    const { request } = fixture(t);
    assert.equal((await submit(request, [download(10), { ...download(11), version: "9.0.0" }])).status, 422);
    assert.equal((await submit(request, [{ ...download(11), version: "4294967295.0.0" }])).status, 422);
    assert.equal((await submit(request, [{ ...download(11), version: "4294967296.0.0" }])).status, 400);
    assert.equal((await submit(request, [{ ...download(11), version: "01.0.0" }])).status, 400);
    assert.equal((await submit(request, [{ ...download(11), plugin_id: "Example.Payday" }])).status, 400);
    assert.equal((await submit(request, [{ ...favorite(12, true), plugin_id: "example.unknown" }])).status, 422);
    assert.equal((await submit(request, [{ ...favorite(12, true), notes: "不接收额外字段" }])).status, 400);
    assert.equal((await submit(request, [favorite(12, "true")])).status, 400);
    assert.equal((await submit(request, [{ ...download(10), event_id: "invalid" }])).status, 400);
    assert.equal((await submit(request, Array(33).fill(download(10)))).status, 400);
    assert.equal((await submit(request, [download(10)], "other")).status, 400);
    const oversized = await request("/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(16 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    await payday(await request("/v1/stats?channel=preview"), 0, 0);
});

test("单个匿名安装超过频率限制时不进账，重试旧事件仍可成功", async t => {
    const { request } = fixture(t);
    for (let start = 0; start < 120; start += 30) {
        const events = Array.from({ length: 30 }, (_, i) => download(start + i));
        await payday(await submit(request, events), start + 30, 0);
    }
    assert.equal((await submit(request, [download(120)])).status, 429);
    await payday(await submit(request, [download(119)]), 120, 0);
    await payday(await submit(request, [download(121)], "preview", 2), 121, 0);
});
