import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync, readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";

const dir = new URL("../", import.meta.url);
const read = name => readFileSync(new URL(name, dir), "utf8");
const manifest = JSON.parse(read("plugin.json"));
const cityNames = JSON.parse(read("city-names.json"));
const defaults = Object.fromEntries(manifest.settings.map(field => [field.key, field.default]));
const engine = runInNewContext(`${read("main.js")}\n({computeState, refresh, action, layoutFor, toCanvas})`);
const states = {};
const outputs = {};
const exe = process.argv[2];

function checkBounds(canvas, width, height) {
    function inside(x, y) {
        const alternatives = value => typeof value === "number" ? [value] : value.map;
        assert.ok(alternatives(x).every(value => value >= 0 && value <= width), `画布 x 越界：${JSON.stringify(x)}`);
        assert.ok(alternatives(y).every(value => value >= 0 && value <= height), `画布 y 越界：${JSON.stringify(y)}`);
    }
    for (const node of canvas.nodes) {
        if (node.rect) {
            const [x, y, w, h] = node.rect;
            inside(x, y);
            inside(x + w, y + h);
        } else if (node.circle) {
            const [x, y, r] = node.circle;
            inside(x - r, y - r);
            inside(x + r, y + r);
        } else if (node.line) {
            inside(...node.line.slice(0, 2));
            inside(...node.line.slice(2));
        } else if (node.at) {
            inside(...node.at);
            assert.ok(node.at[1] <= height - 3);
        } else if (node.translate) {
            inside(...node.translate);
        }
    }
}

function offsetMinutes(zone, now) {
    try {
        const formatter = new Intl.DateTimeFormat("en", {timeZone: zone, timeZoneName: "longOffset"});
        const name = formatter.formatToParts(now).find(part => part.type === "timeZoneName").value;
        const parts = /^GMT([+-])(\d\d):(\d\d)$/.exec(name);
        return parts ? (parts[1] === "+" ? 1 : -1) * (+parts[2] * 60 + +parts[3]) : 0;
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
    }
}

for (const file of readdirSync(new URL("fixtures/", dir)).filter(name => name.endsWith(".json")).sort()) {
    const name = file.replace(/\.json$/, "");
    const mock = JSON.parse(read(`fixtures/${file}`));
    const settings = {...defaults, ...mock.settings};
    const zones = {};
    for (const {zone} of JSON.parse(settings.cities)) {
        const offset = offsetMinutes(zone, mock.now);
        if (offset !== undefined) zones[zone] = {offset_minutes: offset, dst: name === "dst-after"};
    }
    const input = {...mock, settings, zones, tz: {name: "Asia/Shanghai", offset_minutes: 480},
        data: {"city-names.json": cityNames}};
    const state = engine.computeState(input);
    assert.equal(engine.toCanvas(state).height, state.layout.height - 58);
    states[name] = JSON.parse(JSON.stringify(state));
    const output = JSON.parse(JSON.stringify(engine.refresh(input)));
    outputs[name] = output;
    checkBounds(output.canvas, 387, output.canvas.height);
    if (output.pinned) checkBounds(output.pinned.canvas, output.pinned.canvas.width, 22);
    if (exe && name !== "invalid") {
        const run = spawnSync(exe, ["--plugin-test", fileURLToPath(new URL("plugin.json", dir)),
            "--input", fileURLToPath(new URL(`fixtures/${file}`, dir))], {
            encoding: "utf8", windowsHide: true
        });
        assert.equal(run.status, 0, `${file}\n${run.error ?? ""}\n${run.stderr}\n${run.stdout}`);
        const raw = run.stdout.split(/\r?\n/).find(line => line.startsWith("{"));
        assert.deepEqual(JSON.parse(raw), output, file);
    }
    if (name === "default-three") {
        const chosen = engine.action({...input, action: {id: "pin_2"}});
        assert.equal(chosen.storage.zone, state.cities[2].zone);
        assert.equal(chosen.pinned.canvas.binds.pinTime.zone, state.cities[2].zone);
        assert.deepEqual(Array.from(chosen.canvas.nodes.filter(node => node.hit), node => node.hit.action),
            ["pin_0", "pin_1", "pin_2"]);
        assert.deepEqual(Array.from(chosen.canvas.nodes.filter(node => node.stroke === "$accent"), node => node.id),
            ["tile_2"]);
        const firstMode = {...input, settings: {...settings, pinned_city: "first"}};
        const savedInFirstMode = {...chosen.storage, setting: "first"};
        const first = engine.refresh({...firstMode, storage: savedInFirstMode});
        assert.equal(first.pinned.canvas.binds.pinTime.zone, state.cities[0].zone);
        assert.equal(first.canvas.nodes.some(node => node.hit || node.hover), false);
        assert.deepEqual(Array.from(first.canvas.nodes.filter(node => node.stroke === "$accent"), node => node.id),
            ["tile_0"]);
        const ignored = engine.action({...firstMode, storage: chosen.storage, action: {id: "pin_1"}});
        assert.deepEqual(ignored.storage, chosen.storage);
        assert.equal(ignored.pinned.canvas.binds.pinTime.zone, state.cities[0].zone);
        const selectedAgain = engine.refresh({...input, storage: ignored.storage});
        assert.equal(selectedAgain.pinned.canvas.binds.pinTime.zone, state.cities[2].zone);
    }
    console.log(`${name} 通过${exe ? "（含宿主）" : ""}`);
}

assert.equal(Object.keys(states).length, 8);
assert.equal(states["default-three"].cities.length, 3);
assert.deepEqual(states["default-three"].layout, {rows: 1, diameter: 64, height: 236});
assert.equal(engine.layoutFor(5).rows, 1);
assert.equal(engine.layoutFor(6).rows, 2);
assert.equal(states.ten.cities.length, 10);
assert.equal(outputs.ten.canvas.nodes.filter(node => node.hit).length, 10);
for (const fixture of ["default-three", "ten"]) {
    const {height, nodes} = outputs[fixture].canvas;
    const stripRows = nodes.flatMap((node, index) => node.rect && node.fill === "#2E64B5"
        ? [{bar: node, label: nodes[index - 1]}] : []);
    assert.deepEqual(stripRows.map(({label}) => label.text), states[fixture].cities.map(city => city.name));
    for (const [index, {bar, label}] of stripRows.entries()) {
        assert.ok(label.size >= 9 && label.size <= 10 && label.weight === 400 && label.fill === "$text",
            "日夜条城市名使用正常字重并保留可读字号");
        assert.ok(label.at[0] + label.max_width + 4 <= bar.rect[0], "城市名与色条之间需要留空");
        assert.equal(bar.rect[0] + bar.rect[2], 381, "色条保留右侧翻页留白");
        assert.equal(label.at[1], bar.rect[1] + bar.rect[3], "城市名与对应色条对齐");
        if (index) assert.ok(label.at[1] - stripRows[index - 1].label.at[1] >= label.size + 2,
            "相邻城市名留出行间空隙");
    }
    const last = stripRows.at(-1);
    assert.ok(nodes.find(node => node.text?.startsWith("24  ")).at[1] <= height - 3);
    assert.ok(last.bar.rect[1] + last.bar.rect[3] < height - 11, "保留底部刻度空间");
}
assert.deepEqual(states.ten.layout, {rows: 2, diameter: 46, height: 362});
assert.equal(outputs.ten.canvas.binds.c9Minute.clock_angle.zone, "America/Los_Angeles");
assert.equal(outputs.ten.pinned.canvas.binds.pinTime.zone, "Australia/Sydney");
assert.equal(outputs.fractional.pinned.canvas.binds.pinTime.zone, "Asia/Kathmandu");
assert.equal(outputs.fractional.pinned.canvas.fit_width, true);
assert.equal(outputs.fractional.pinned.canvas.nodes.at(-1).text, "{pinTime}  加德满都");
assert.equal(cityNames._metadata.spdx, "Unicode-3.0");
assert.deepEqual(states["default-three"].cities[2].workSegments, [[0, 420], [1320, 1440]]);
assert.equal(states["date-line"].cities[0].day, "明天");
assert.equal(states["date-line"].cities[1].day, "昨天");
assert.equal(states["date-line"].pinned.time, "00:30");
assert.deepEqual(states.fractional.cities.map(city => [city.time, city.offsetLabel]), [["11:30", "−2.5h"], ["11:45", "−2.25h"]]);
assert.equal(states["dst-before"].pinned.time, "01:59");
assert.equal(states["dst-after"].pinned.time, "03:00");
assert.equal(states["dst-before"].cities[0].offset, -300);
assert.equal(states["dst-after"].cities[0].offset, -240);
assert.equal(outputs["dst-before"].next_refresh_at, outputs["dst-after"].next_refresh_at - 60);
assert.equal(outputs.empty.pinned, null);
assert.equal(states.invalid.pinned.name, "纽约");
assert.equal(states.invalid.missing, 1);
