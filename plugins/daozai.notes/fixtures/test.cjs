const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sdk = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8"), sdk);
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, `${name}.json`), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"));
const run = (kind, input) => JSON.parse(JSON.stringify(sdk[kind](input)));
const act = (input, id, form = {}) => run("action", { ...input, action: { id, form } });
const now = fixture("normal").now;
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.group || [])]);
const rendered = output => flatten(output.canvas.nodes);
const entries = output => rendered(output).filter(node => node.hit?.action?.startsWith("select-"));
const pinText = slide => flatten(slide.nodes).find(node => node.text !== undefined).text;
const hit = (output, id) => rendered(output).find(node => node.hit?.action === id);

test("清理换行、空白与控制字符，并按 UTF-8 计算存储大小", () => {
    assert.equal(sdk.cleanText("  上\r\n下\t行\x00🧷  "), "上\n下 行🧷");
    assert.equal(sdk.singleLine(" \n上🧷\x00\t下 ", 4), "上🧷 下");
    assert.equal(sdk.singleLine("上 🧷 下", 4), "上 🧷");
    for (const storage of [{}, {text: "上é🧷\n"}, {text: "\ud83d"}, {text: "便签🧷".repeat(1000)}]) {
        assert.equal(sdk.storageBytes(storage), Buffer.byteLength(JSON.stringify(storage), "utf8"));
    }
});

test("手写添加、编辑、复制、选择和删除", () => {
    const added = act({ now }, "add", { note: "  第一条\n下一行  " });
    assert.equal(added.storage.notes[0].text, "第一条\n下一行");
    assert.equal(added.storage.notes[0].color, "#FFE58A");
    assert.ok(rendered(added).some(node => node.hit?.copy === "第一条\n下一行"));
    assert.equal(added.status.fields[0].multiline, undefined);
    const pasted = act({ now, storage: added.storage }, "add-pasted", { note: "粘贴试验" });
    assert.equal(pasted.storage.notes[0].color, "#8FD3F5");
    const selected = act({ now, storage: pasted.storage }, "select-n-1");
    const managed = act({ now, storage: selected.storage }, "manage");
    assert.equal(managed.status.fields[0].value, "第一条\n下一行");
    assert.equal(managed.status.fields[0].multiline, true);
    assert.equal(managed.status.actions[0].id, "save");
    const saved = act({ now, storage: managed.storage }, "save", { edit_note: "新正文" });
    assert.equal(saved.status.fields[0].value, "新正文");
    const removed = act({ now, storage: saved.storage }, "delete");
    assert.equal(removed.storage.notes.length, 1);
    assert.ok(rendered(removed).some(node => node.text === "粘贴试验"));
});

test("左下录入和右上搜索共享原生表单与画布动作", () => {
    const initial = fixture("empty");
    const added = act(initial, "add", {note: "下周办年卡"});
    assert.equal(added.storage.notes[0].text, "下周办年卡");
    const findButton = (output, id) => rendered(output).find(node => node.hit?.action === id);
    assert.deepEqual(findButton(added, "add").rect, [136, 208, 21, 20]);
    assert.deepEqual(findButton(added, "search").rect, [181, 7, 21, 24]);
    assert.deepEqual(manifest.statusLayout.canvasFields.map(({key, action}) => [key, action]),
        [["note", "add"], ["search", "search"], ["edit_note", "save"]]);
    assert.deepEqual(added.status.actions.map(action => action.id), ["add", "search"]);
    const paste = act({ ...initial, storage: added.storage }, "paste");
    assert.equal(paste.status.fields[0].label, "粘贴内容");
    assert.equal(paste.status.fields[0].multiline, true);
    assert.ok(!findButton(paste, "add"));
    const pasted = act({ ...initial, storage: paste.storage }, "add-pasted", {note: "摘录"});
    assert.equal(pasted.storage.notes[0].color, "#8FD3F5");
    assert.equal(pasted.storage.notes[0].text, "摘录");
});

test("长便签在大幅多行编辑区保留原文，并可提交末行修改", () => {
    const initial = fixture("editor-long");
    const managed = run("refresh", initial);
    const field = managed.status.fields[0];
    const anchor = manifest.statusLayout.canvasFields.find(({key}) => key === field.key);
    assert.ok(field.multiline);
    assert.equal(field.value, initial.storage.notes[0].text);
    assert.ok(field.value.split("\n").length > 8);
    assert.ok(anchor.rect[2] >= 350 && anchor.rect[3] >= 120);
    assert.ok(anchor.rect[1] + anchor.rect[3] < managed.canvas.height);
    assert.ok(rendered(managed).some(node => node.hit?.action === anchor.action));
    const modified = field.value.replace("最后一行", "末行已更新");
    const saved = act({ ...initial, storage: managed.storage }, "save", { [field.key]: modified });
    assert.equal(saved.storage.notes[0].text, modified);
    assert.equal(saved.status.fields[0].value, modified);
});

test("纸卡右上角切换置顶，底部铅笔和常驻显示对应提示", () => {
    const initial = fixture("normal");
    const normal = run("refresh", initial);
    for (const [action, hint] of [["done", "完成"], ["pin-island", "取消常驻"], ["manage", "编辑便签"]]) {
        assert.equal(hit(normal, action).hover.hint, hint);
    }
    assert.equal(rendered(normal).find(node => node.hit?.copy).hover.hint, "复制");
    assert.equal(hit(normal, "pin").hover.hint, "取消置顶");
    assert.ok(hit(normal, "pin").rect[0] >= 120 && hit(normal, "pin").rect[1] < 30);
    const unpinned = act(initial, "pin");
    assert.equal(unpinned.storage.notes[0].pinned, null);
    assert.equal(hit(unpinned, "pin").hover.hint, "置顶便签");
    const managed = act(initial, "manage");
    assert.equal(hit(managed, "pin"), undefined);
    assert.ok(hit(managed, "pin-up"));
    assert.ok(hit(managed, "pin-down"));
});

test("手动完成留在画布提示，3 秒内可撤销，到期后归档并在 30 天后清理", () => {
    const initial = fixture("normal");
    const done = act(initial, "done");
    assert.equal(done.next_refresh_at, now / 1000 + 3);
    assert.deepEqual(done.canvas.binds.undo.progress, [now / 1000 + 2, now / 1000 + 3]);
    assert.equal(done.notice, undefined);
    assert.ok(rendered(done).some(node => node.hit?.action === "undo"));
    const undo = act({ ...initial, now: now + 2999, storage: done.storage }, "undo");
    assert.equal(undo.storage.notes[0].done_at, null);
    assert.equal(undo.storage.current, "n-3");
    const missed = act({ ...initial, now: now + 3000, storage: done.storage }, "undo");
    assert.equal(missed.storage.notes[0].done_at, now / 1000);
    assert.equal(missed.storage.pending, null);
    assert.ok(!rendered(missed).some(node => node.hit?.action === "undo"));
    const completed = run("refresh", fixture("completed"));
    assert.ok(rendered(completed).some(node => node.text === "会议室 B 改到 3 楼"));
    assert.equal(run("refresh", fixture("expired")).storage.notes.length, 2);
});

test("编辑配色保存到该便签，正文、来源和当前编辑草稿不变", () => {
    const initial = fixture("normal");
    const outsideEditor = act(initial, "color-green");
    assert.deepEqual(outsideEditor.storage.notes, initial.storage.notes);
    const managed = act(initial, "manage");
    const palette = rendered(managed).filter(node => node.hit?.action?.startsWith("color-"));
    assert.equal(palette.length, 4);
    assert.equal(palette.find(node => node.hit.action === "color-yellow").hover.hint, "黄色");
    assert.equal(palette.find(node => node.hit.action === "color-green").hover.hint, "浅绿");
    const changed = act({ ...initial, storage: managed.storage }, "color-green", { edit_note: "未保存的\n编辑草稿" });
    assert.equal(changed.status.fields[0].value, "未保存的\n编辑草稿");
    assert.deepEqual(changed.storage.notes[0], { ...managed.storage.notes[0], color: "#B8E6A0" });
    const saved = act({ ...initial, storage: changed.storage }, "save", { edit_note: "保存后的正文" });
    assert.equal(saved.storage.notes[0].text, "保存后的正文");
    assert.equal(saved.storage.notes[0].color, "#B8E6A0");
    const listed = act({ ...initial, storage: saved.storage }, "back");
    assert.ok(rendered(listed).some(node => node.rect?.[0] === 5 && node.fill === "#B8E6A0"));
    assert.equal(listed.pinned.canvas.nodes[0].group[0].fill, "#B8E6A0");
});

test("切换颜色或置顶排序时，编辑草稿遵守状态表单的多行格式", () => {
    const initial = fixture("normal");
    const editor = act(initial, "manage");
    const input = { ...initial, storage: editor.storage };
    const text = "  首行\r\n\t第二行\u0000\r末尾\u0085 ";
    const recolored = act(input, "color-green", { edit_note: text });
    assert.equal(recolored.status.fields[0].value, "  首行\n第二行\n末尾 ");
    assert.equal(recolored.storage.notes[0].text, editor.storage.notes[0].text);
    const reordered = act(input, "pin-down", { edit_note: text });
    assert.equal(reordered.status.fields[0].value, recolored.status.fields[0].value);
    assert.equal(act(input, "color-blue", { edit_note: "" }).status.fields[0].value, "");
});

test("常驻按钮和列表使用同一蓝标，同一便签再点后停止常驻", () => {
    const initial = fixture("normal");
    const hasBlueRow = (output, id) => {
        const row = hit(output, `select-${id}`);
        return rendered(output).some(node => node.fill === "#5BC2F2" && node.rect?.[1] === row.rect[1] + 8);
    };
    const normal = run("refresh", initial);
    assert.equal(hit(normal, "pin-island").hover.hint, "取消常驻");
    assert.ok(hasBlueRow(normal, "n-3"));
    assert.ok(rendered(normal).some(node => node.path && node.stroke === "#5BC2F2"));
    const stopped = act(initial, "pin-island");
    assert.equal(stopped.pinned, null);
    assert.equal(hit(stopped, "pin-island").hover.hint, "设为常驻");
    assert.equal(hasBlueRow(stopped, "n-3"), false);
    const reloaded = run("refresh", { ...initial, storage: stopped.storage });
    assert.equal(reloaded.pinned, null);
    const resumed = act({ ...initial, storage: stopped.storage }, "pin-island");
    assert.match(pinText(resumed.pinned.canvas), /周五前/);
    const selected = act({ ...initial, storage: resumed.storage }, "select-n-2");
    const switched = act({ ...initial, storage: selected.storage }, "pin-island");
    assert.equal(hasBlueRow(switched, "n-3"), false);
    assert.ok(hasBlueRow(switched, "n-2"));
    const specified = fixture("specified");
    const chosen = act(specified, "select-n-1");
    const explicit = act({ ...specified, storage: chosen.storage }, "pin-island");
    assert.equal(explicit.pinned, null);
    assert.equal(run("refresh", { ...specified, storage: explicit.storage }).pinned, null);
});

test("单张常驻和轮播给宿主传原文全部行及末尾", () => {
    const initial = fixture("pinned-long");
    const original = initial.storage.notes.map(note => note.text.replaceAll("\n", " "));
    assert.ok(original.every(text => [...text].length > 120));
    const latest = run("refresh", { ...initial, settings: { pin_mode: "latest" } }).pinned.canvas;
    const rotate = run("refresh", initial).pinned.canvas;
    assert.equal(pinText(latest), original[0]);
    assert.deepEqual(rotate.map(pinText), original);
    for (const slide of [latest, ...rotate]) {
        const node = flatten(slide.nodes).find(node => node.text);
        assert.equal(slide.width, 150);
        assert.equal(slide.fit_width, true);
        assert.equal(node.max_width, 135);
        assert.equal(node.loop.kind, "flow");
    }
});

test("多条置顶、过滤搜索和三种常驻模式", () => {
    const input = fixture("normal");
    const latest = run("refresh", input);
    assert.match(pinText(latest.pinned.canvas), /周五前/);
    const specified = run("refresh", fixture("specified"));
    assert.equal(pinText(specified.pinned.canvas), "会议室 B 改到 3 楼");
    const rotate = fixture("rotate");
    const first = run("refresh", rotate);
    assert.ok(Array.isArray(first.pinned.canvas));
    assert.deepEqual(first.pinned.canvas.map(pinText), rotate.storage.notes
        .filter(note => note.pinned).map(note => note.text.replaceAll("\n", " ")));
    assert.equal(first.next_refresh_at, undefined);
    assert.equal(run("refresh", fixture("empty")).pinned, null);
    const chosen = act(input, "select-n-2");
    const pinned = act({ ...input, storage: chosen.storage }, "pin");
    assert.equal(pinned.storage.notes.filter(note => note.pinned).length, 3);
    assert.equal(entries(pinned)[0].hit.action, "select-n-2");
    const moved = act({ ...input, now: now + 50, storage: pinned.storage }, "pin-down");
    assert.notEqual(entries(moved)[0].hit.action, "select-n-2");
    const pinIsland = act({ ...input, storage: pinned.storage }, "pin-island");
    assert.equal(pinText(pinIsland.pinned.canvas), "完成一次专注 · 25 分钟");
    const selectedIsland = run("refresh", { ...input, settings: { pin_mode: "specified" }, storage: pinIsland.storage });
    assert.equal(pinText(selectedIsland.pinned.canvas), "完成一次专注 · 25 分钟");
    const search = act(input, "search", { search: "会议室 b" });
    assert.deepEqual(entries(search).map(node => node.hit.action), ["select-n-1"]);
    assert.equal(entries(act({ ...input, storage: search.storage }, "search")).length, input.storage.notes.length);
});

test("结束专注写入红色便签，同一事件只写一次", () => {
    const event = { name: "focus.finished", id: "focus-25", at: now / 1000, minutes: 25 };
    const first = run("event", { now, event });
    assert.equal(first.storage.notes[0].text, "完成一次专注 · 25 分钟");
    assert.equal(first.storage.notes[0].color, "#FF8A7A");
    assert.equal(run("event", { now, event, storage: first.storage }).storage.notes.length, 1);
});

test("千条便签可翻页，展示输出受限，接近存储上限时保留原数据", () => {
    const template = fixture("normal").storage.notes[0];
    const notes = Array.from({ length: 1000 }, (_, index) => ({ ...template, id: `n-${1000 - index}`, text: `便签 ${1000 - index}` }));
    const input = { now, storage: { notes, next_id: 1001 } };
    const output = run("refresh", { ...input, settings: { pin_mode: "rotate" } });
    const { storage, ...display } = output;
    assert.ok(Buffer.byteLength(JSON.stringify(display)) < 64 * 1024);
    assert.equal(output.pinned.canvas.length, 32);
    assert.ok(rendered(output).filter(node => node.hit).length <= 64);
    assert.ok(rendered(output).some(node => node.scroll?.content > node.clip?.[3]));
    assert.equal(storage.notes.length, 1000);
    assert.equal(entries(act(input, "next"))[0].hit.action, "select-n-982");

    const large = Array.from({ length: 375 }, (_, index) => ({ ...template, id: `n-${index + 1}`, text: "便".repeat(190) }));
    const nearFull = { now, storage: { notes: large, next_id: 376 } };
    assert.match(run("refresh", nearFull).status.alert, /导出备份/);
    let full = run("refresh", nearFull);
    for (let i = 0; i < 20; i++) full = act({ now, storage: full.storage }, "add", { note: "便".repeat(200) });
    assert.match(full.status.alert, /已满/);
    assert.ok(Buffer.byteLength(JSON.stringify(full.storage)) <= 256 * 1024);
    assert.ok(full.storage.notes.length >= large.length);
});

test("正常、撤销和空状态可直接出图", () => {
    const normal = run("refresh", fixture("normal"));
    const pending = run("refresh", fixture("pending-undo"));
    const empty = run("refresh", fixture("empty"));
    assert.deepEqual([normal, pending, empty].map(output => output.canvas.height), [230, 230, 230]);
    assert.ok(rendered(normal).some(node => node.text === "周五前把报价单发给阿杰"));
    assert.ok(rendered(pending).some(node => node.text === "撤销"));
    assert.ok(rendered(empty).some(node => node.text === "还没有便签"));
});
