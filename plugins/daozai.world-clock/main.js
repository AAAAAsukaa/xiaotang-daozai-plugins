const DAY_MINUTES = 24 * 60;
const WORK_MINUTES = 9 * 60;
const DEFAULT_NAMES = {
    "America/Los_Angeles": "洛杉矶", "America/New_York": "纽约", "Asia/Dubai": "迪拜",
    "Asia/Kathmandu": "加德满都", "Asia/Kolkata": "新德里", "Asia/Seoul": "首尔",
    "Asia/Shanghai": "北京", "Asia/Singapore": "新加坡", "Asia/Tokyo": "东京",
    "Australia/Sydney": "悉尼", "Europe/London": "伦敦", "Europe/Moscow": "莫斯科",
    "Europe/Paris": "巴黎", "Pacific/Auckland": "奥克兰"
};

function minuteOfDay(minutes) {
    return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

function formatTime(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatOffset(delta) {
    const hours = Number((Math.abs(delta) / 60).toFixed(2));
    return delta ? `${delta > 0 ? "+" : "−"}${hours}h` : "同一时间";
}

function workSegments(delta) {
    // 色条以本机午夜为原点。跨午夜时分别保留当天开头和结尾的区段。
    const start = minuteOfDay(9 * 60 - delta);
    const end = start + WORK_MINUTES;
    return end <= DAY_MINUTES ? [[start, end]] : [[0, end - DAY_MINUTES], [start, DAY_MINUTES]];
}

function layoutFor(count) {
    if (count <= 5) return {rows: 1, diameter: 64, height: 236 + Math.max(0, count - 3) * 8};
    return {rows: 2, diameter: 46, height: 322 + (count - 6) * 10};
}

function visible(text, max) {
    return [...text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim()].slice(0, max).join("");
}

function computeState({settings, zones, now, tz, storage, data}) {
    const configured = [...JSON.parse(settings.cities), ...JSON.parse(settings.more_cities ?? "[]")].slice(0, 10);
    const minute = Math.floor(now / 60000);
    const localMinute = minute + tz.offset_minutes;
    const localDay = Math.floor(localMinute / DAY_MINUTES);
    const dateLabel = ["前天", "昨天", "今天", "明天", "后天"];
    const cities = [];
    for (const row of configured) {
        const zone = row.zone.trim();
        const offset = zones?.[zone]?.offset_minutes;
        if (!Number.isInteger(offset)) continue;
        const named = visible(row.name, 80);
        const name = named && named !== "时区默认名" ? named
            : (DEFAULT_NAMES[zone] ?? data?.["city-names.json"]?.[zone] ?? zone.split("/").at(-1).replaceAll("_", " "));
        const cityMinute = minute + offset;
        const cityTime = minuteOfDay(cityMinute);
        const dateDelta = Math.floor(cityMinute / DAY_MINUTES) - localDay;
        const delta = offset - tz.offset_minutes;
        cities.push({
            name, zone, offset, index: cities.length,
            dst: zones[zone].dst, dateDelta, minutes: cityTime,
            time: formatTime(cityTime), day: dateLabel[dateDelta + 2], offsetLabel: formatOffset(delta),
            daylight: cityTime >= 6 * 60 && cityTime < 18 * 60, workSegments: workSegments(delta)
        });
    }
    const selected = settings.pinned_city.trim();
    const selectOnPage = selected !== "first";
    const saved = selectOnPage && storage?.setting === selected
        ? cities.find(city => city.zone === storage.zone && city.name === storage.name) : undefined;
    const pinned = selectOnPage
        ? (saved ?? cities.find(city => city.name === selected || city.zone === selected) ?? cities[0])
        : cities[0];
    return {
        cities, pinned, selectOnPage, layout: layoutFor(cities.length),
        localZone: tz.name, localMinutes: minuteOfDay(localMinute),
        missing: configured.length - cities.length,
        beginAt: (localDay * DAY_MINUTES - tz.offset_minutes) * 60,
        nextRefresh: (minute + 1) * 60
    };
}

function dialBindings(binds, key, zone) {
    binds[key + "Day"] = {daylight: {zone, hours: [6, 18]}};
    binds[key + "Hour"] = {clock_angle: {zone, hand: "hour"}};
    binds[key + "Minute"] = {clock_angle: {zone, hand: "minute"}};
    binds[key + "Time"] = {now: "HH:mm", zone};
}

function dial(key, x, y, radius) {
    const color = (night, day) => ({bind: key + "Day", pick: [night, day]});
    const ink = color("#E8EDF5", "#253346");
    const hand = (kind, length, width) => ({
        group: [{line: [0, 0, 0, -radius * length], stroke: ink, width, cap: "round"}],
        translate: [x, y], rotate: {bind: key + kind}
    });
    const marks = [[0,-1],[1,0],[0,1],[-1,0]].map(([dx,dy]) => ({
        line: [x + dx * radius * 0.72, y + dy * radius * 0.72, x + dx * radius * 0.86, y + dy * radius * 0.86],
        stroke: ink, width: Math.max(0.7, radius / 28), cap: "round"
    }));
    return [
        {circle: [x, y, radius], fill: color("#101626", "#F4F1EA")},
        ...marks,
        hand("Hour", 0.48, Math.max(1.0, radius / 8)),
        hand("Minute", 0.67, Math.max(0.75, radius / 13)),
        {circle: [x, y, Math.max(1.1, radius / 10)], fill: color("#6EA6FF", "#EC9A37")}
    ];
}

function toPinned({pinned: city}) {
    if (!city) return null;
    const binds = {};
    dialBindings(binds, "pin", city.zone);
    return {canvas: {width: 119, fit_width: true, binds, nodes: [
        ...dial("pin", 11, 11, 9),
        {text: `{pinTime}  ${visible(city.name, 8)}`, at: [25, 15], size: 11, max_width: 90, weight: 700}
    ]}};
}

function toCanvas({cities, layout, localZone, missing, beginAt, pinned, selectOnPage}) {
    const height = layout.height - 58;
    if (!cities.length) return {height, nodes: [
        {text: missing ? "没有可用的城市时区" : "还没有添加城市", at: [193, 77], size: 19, weight: 700, align: "center"},
        {text: "打开插件设置，搜索城市并添加", at: [193, 100], size: 12, fill: "$muted", align: "center"}
    ]};
    const binds = {dayProgress: {progress: [beginAt, beginAt + 86400]}};
    const nodes = [];
    const columns = Math.min(cities.length, 5);
    const cell = 387 / columns;
    const radius = layout.diameter / 2;
    const rowHeight = layout.rows === 1 ? 114 : 86;
    const [nameY, timeY, dateY] = layout.rows === 1 ? [17, 30, 39] : [16, 28, 35];
    for (const city of cities) {
        const key = `c${city.index}`;
        const x = (city.index % columns + 0.5) * cell;
        const y = Math.floor(city.index / columns) * rowHeight;
        dialBindings(binds, key, city.zone);
        nodes.push({
            rect: [x - cell / 2 + 2, y + 1, cell - 4, rowHeight - 4], r: 10,
            fill: "$card",
            ...(selectOnPage ? {hit: {action: `pin_${city.index}`}, hover: {lift: 1, opacity: 0.85}} : {}),
            id: `tile_${city.index}`, animate: {ms: 180},
            stroke: pinned === city ? "$accent" : undefined, width: 1
        }, ...dial(key, x, y + radius + 5, radius),
        {text: visible(city.name, 12), at: [x, y + radius * 2 + nameY], max_width: cell - 10,
            size: 10, weight: 650, align: "center"},
        {text: `{${key}Time}`, at: [x, y + radius * 2 + timeY], size: 12, weight: 700, align: "center"},
        {text: city.offsetLabel === "同一时间" ? "同一时间" : `${city.day} ${city.offsetLabel}`,
            at: [x, y + radius * 2 + dateY], size: 8, fill: "$muted", align: "center", max_width: cell - 8});
    }
    const stripX = 64;
    const stripWidth = 381 - stripX;
    const firstY = layout.rows * rowHeight + (layout.rows === 1 ? 9 : 5);
    const rowGap = 12;
    const xAt = minute => stripX + stripWidth * minute / DAY_MINUTES;
    for (const city of cities) {
        const y = firstY + city.index * rowGap;
        nodes.push({text: visible(city.name, 12), at: [3, y + 7], max_width: stripX - 8,
            size: 9.5, weight: 400, fill: "$text", opacity: 0.86},
            {rect: [stripX, y + 2, stripWidth, 5], r: 2, fill: "#2E64B5"});
        for (const [from, to] of city.workSegments) {
            nodes.push({rect: [xAt(from), y + 2, xAt(to) - xAt(from), 5], r: 2, fill: "#FFC43D"});
        }
    }
    const cursorX = {bind: "dayProgress", map: [stripX, stripX + stripWidth]};
    const lastY = firstY + (cities.length - 1) * rowGap + 7;
    nodes.push({line: [cursorX, firstY - 1, cursorX, lastY + 2], stroke: "#FFFFFF", width: 1, cap: "round"});
    for (const hour of [0, 6, 12, 18, 24]) {
        const x = xAt(hour * 60);
        nodes.push({text: hour === 24 ? `24  ${DEFAULT_NAMES[localZone] ?? visible(localZone.split("/").at(-1), 12)}` : String(hour),
            at: [x, lastY + 9], size: 8, fill: "$muted", align: hour === 24 ? "right" : "center"});
    }
    return {height, binds, nodes};
}

function refresh(input) {
    const state = computeState(input);
    return {canvas: toCanvas(state), pinned: toPinned(state), next_refresh_at: state.nextRefresh, storage: input.storage ?? null};
}

function action(input) {
    const match = /^pin_(\d+)$/.exec(input.action.id);
    const state = computeState(input);
    const city = state.selectOnPage && match ? state.cities[Number(match[1])] : undefined;
    return refresh(city ? {...input, storage: {zone: city.zone, name: city.name, setting: input.settings.pinned_city.trim()}} : input);
}
