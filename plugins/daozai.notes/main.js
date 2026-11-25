const DAY = 86400;
const RETENTION = 30 * DAY;
const STORE_LIMIT = 256 * 1024;
const STORE_WARNING = STORE_LIMIT * 0.9;
const PAGE_SIZE = 18;
const PIN_SLIDES = 32;
const COLORS = { handwritten: "#FFE58A", focus: "#FF8A7A", pasted: "#8FD3F5" };
const COLOR_OPTIONS = [
    ["yellow", "黄色", COLORS.handwritten],
    ["red", "珊瑚红", COLORS.focus],
    ["blue", "天蓝", COLORS.pasted],
    ["green", "浅绿", "#B8E6A0"]
];
const ISLAND_BLUE = "#5BC2F2";
const PAPER_TRANSITION = { ms: 280, ease: "spring" };

function trimTo(text, max) {
    return [...text].slice(0, max).join("").trim();
}

function isControl(code) {
    return code < 32 || (code >= 127 && code <= 159);
}

function singleLine(text, max) {
    let line = "";
    let count = 0;
    let space = false;
    for (const ch of text) {
        if (!ch.trim() || isControl(ch.charCodeAt(0))) {
            space = count > 0;
            continue;
        }
        if (space) {
            if (++count === max) break;
            line += " ";
            space = false;
        }
        line += ch;
        if (++count === max) break;
    }
    return line;
}

function cleanText(value) {
    const input = String(value ?? "");
    let text = "";
    let space = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "\r" || ch === "\n") {
            if (ch === "\r" && input[i + 1] === "\n") i++;
            text += "\n";
            space = false;
        } else if (!ch.trim()) {
            if (!space) text += " ";
            space = true;
        } else {
            if (!isControl(ch.charCodeAt(0))) text += ch;
            space = false;
        }
    }
    return trimTo(text, 200);
}

function editorText(text) {
    return [...text.replace(/\r\n?/g, "\n")]
        .filter(ch => ch === "\n" || !isControl(ch.charCodeAt(0))).slice(0, 200).join("");
}

function storageBytes(storage) {
    // 每个百分号编码解成一个 UTF-8 字节。
    return unescape(encodeURI(JSON.stringify(storage))).length;
}

function capacityBytes(storage) {
    const { notes, ...metadata } = storage;
    // 短便签先算上界，接近容量时再精确序列化整个便签库。
    let upper = storageBytes(metadata) + 12;
    for (const note of notes) {
        const { id, text, color, source, pinned, done_at, created_at } = note;
        if (typeof id !== "string" || typeof text !== "string" || typeof color !== "string" || typeof source !== "string"
            || !Object.hasOwn(COLORS, source) || (COLORS[source] !== color && !COLOR_OPTIONS.some(option => option[2] === color))
            || Object.keys(note).length !== 7 || !Number.isSafeInteger(created_at)
            || (pinned !== null && typeof pinned !== "number")
            || (done_at !== null && !Number.isSafeInteger(done_at))) {
            return storageBytes(storage);
        }
        // 字段名、引号和分隔符占不到 80 字节。单个 UTF-16 码元的 JSON 转义最多占 6 字节。
        upper += 80 + 6 * (id.length + text.length) + color.length + source.length + 17
            + (pinned === null ? 4 : 24) + (done_at === null ? 4 : 17);
        if (upper >= STORE_WARNING) return storageBytes(storage);
    }
    return upper;
}

function islandNotes(storage, mode, active, pinned, window) {
    if (mode === "rotate") {
        if (pinned.length <= PIN_SLIDES) return pinned;
        const start = (window * PIN_SLIDES) % pinned.length;
        return pinned.slice(start, start + PIN_SLIDES)
            .concat(pinned.slice(0, Math.max(0, start + PIN_SLIDES - pinned.length)));
    }
    const note = mode === "specified" ? active.find(note => note.id === storage.pin_id) : active[0];
    return note ? [note] : [];
}

function computeState(input) {
    const { action, event, settings = {}, storage: saved } = input;
    const now = Math.floor(input.now / 1000);
    const pinMode = ["latest", "rotate", "specified"].includes(settings.pin_mode) ? settings.pin_mode : "latest";
    const pinOverride = saved?.pin_override === pinMode ? pinMode : null;
    const pinWindow = Math.floor(now / (8 * PIN_SLIDES));
    const storage = {
        notes: (saved?.notes ?? []).filter(note => !note.done_at || note.done_at + RETENTION > now),
        current: saved?.current ?? null,
        next_id: saved?.next_id ?? 1,
        pin_id: pinOverride ? saved.pin_id ?? null : settings.pin_id || saved?.pin_id || null,
        pin_override: pinOverride,
        pending: saved?.pending?.until > input.now ? saved.pending : null,
        last_focus_id: saved?.last_focus_id ?? null,
        search: saved?.search ?? "",
        page: saved?.page ?? 0,
        view: saved?.view ?? "list",
        completed: saved?.completed ?? false
    };
    const lastStored = { ...storage };
    const form = action?.form ?? {};
    const id = action?.id ?? "";
    const color = storage.view === "manage" && id.startsWith("color-")
        ? COLOR_OPTIONS.find(([key]) => key === id.slice(6))?.[2] : undefined;
    const keepDraft = color || id === "pin-up" || id === "pin-down";
    const editDraft = storage.view === "manage" && keepDraft && typeof form.edit_note === "string"
        ? form.edit_note : undefined;
    const focus = event?.name === "focus.finished" && event.id !== storage.last_focus_id && Number.isInteger(event.minutes);
    const draft = cleanText(focus ? `完成一次专注 · ${event.minutes} 分钟`
        : id === "save" ? form.edit_note ?? form.note : form.note);
    const visible = note => Boolean(note.done_at) === storage.completed && note.id !== storage.pending?.id;
    let current = storage.notes.find(note => note.id === storage.current && visible(note))
        ?? storage.notes.find(visible);
    if ((id === "add" || id === "add-pasted" || focus) && draft) {
        const source = focus ? "focus" : id === "add-pasted" ? "pasted" : "handwritten";
        const note = {
            id: `n-${storage.next_id++}`, text: draft, color: COLORS[source], source,
            pinned: null, done_at: null, created_at: focus ? event.at : now
        };
        storage.notes = [note, ...storage.notes];
        if (focus) storage.last_focus_id = event.id;
        if (!focus || !current) {
            storage.current = note.id;
            storage.completed = false;
            storage.search = "";
            storage.page = 0;
            storage.view = "list";
        }
    } else if (id.startsWith("select-")) {
        storage.current = id.slice(7);
    } else if (id === "search") {
        storage.search = singleLine(String(form.search ?? ""), 80);
        storage.page = 0;
    } else if (id === "next" || id === "previous") {
        storage.page += id === "next" ? 1 : -1;
    } else if (id === "completed" || id === "active") {
        storage.completed = id === "completed";
        storage.page = 0;
        storage.view = "list";
    } else if (id === "manage" || id === "back" || id === "paste") {
        storage.view = id === "back" ? "list" : id;
    } else if (id === "undo" && storage.pending) {
        storage.notes = storage.notes.map(note => note.id === storage.pending.id ? { ...note, done_at: null } : note);
        storage.current = storage.pending.id;
        storage.pending = null;
        storage.completed = false;
        storage.view = "list";
    } else if (current) {
        if (id === "delete") {
            storage.notes = storage.notes.filter(note => note.id !== current.id);
            if (storage.pin_id === current.id) storage.pin_id = null;
            storage.view = "list";
        } else if (id === "pin" || id === "done" || id === "restore" || color || (id === "save" && draft)) {
            const updated = { ...current };
            if (id === "pin") updated.pinned = current.pinned ? null : input.now / 1000;
            if (color) updated.color = color;
            if (id === "done") {
                updated.done_at = now;
                storage.pending = { id: current.id, until: input.now + 3000 };
                storage.view = "list";
            }
            if (id === "restore") {
                updated.done_at = null;
                storage.completed = false;
                storage.current = updated.id;
                storage.view = "list";
            }
            if (id === "save") updated.text = draft;
            storage.notes = storage.notes.map(note => note.id === current.id ? updated : note);
        } else if (id === "pin-island" && !current.done_at) {
            const mode = storage.pin_override ? "specified" : pinMode;
            const active = storage.notes.filter(note => !note.done_at);
            const pinned = mode === "rotate" ? active.filter(note => note.pinned).sort((a, b) => b.pinned - a.pinned) : [];
            const resident = islandNotes(storage, mode, active, pinned, pinWindow);
            storage.pin_id = resident.some(note => note.id === current.id) ? null : current.id;
            storage.pin_override = pinMode;
        } else if ((id === "pin-up" || id === "pin-down") && current.pinned) {
            const ordered = storage.notes.filter(note => note.pinned && !note.done_at).sort((a, b) => b.pinned - a.pinned);
            const index = ordered.findIndex(note => note.id === current.id);
            const neighbor = ordered[index + (id === "pin-up" ? -1 : 1)];
            if (neighbor) {
                storage.notes = storage.notes.map(note => {
                    if (note.id === current.id) return { ...note, pinned: neighbor.pinned };
                    if (note.id === neighbor.id) return { ...note, pinned: current.pinned };
                    return note;
                });
            }
        }
    }

    const bytes = capacityBytes(storage);
    const full = bytes > STORE_LIMIT;
    if (full) Object.assign(storage, lastStored);
    current = storage.notes.find(note => note.id === storage.current && visible(note))
        ?? storage.notes.find(visible);
    storage.current = current?.id ?? null;
    const active = [];
    const completed = [];
    const pinned = [];
    const unpinned = [];
    let pending;
    let sortedPins = true;
    for (const note of storage.notes) {
        if (note.id === storage.pending?.id) {
            pending = note;
        } else if (note.done_at) {
            completed.push(note);
        }
        if (!note.done_at) {
            active.push(note);
            if (note.pinned) {
                if (pinned.length && note.pinned > pinned[pinned.length - 1].pinned) sortedPins = false;
                pinned.push(note);
            } else {
                unpinned.push(note);
            }
        }
    }
    if (!sortedPins) pinned.sort((a, b) => b.pinned - a.pinned);
    const mode = storage.pin_override ? "specified" : pinMode;
    const island = islandNotes(storage, mode, active, pinned, pinWindow);
    const keyword = storage.search.toLowerCase();
    const list = storage.completed ? completed : pinned.concat(unpinned);
    const matched = keyword ? list.filter(note => note.text.toLowerCase().includes(keyword)) : list;
    storage.page = Math.max(0, Math.min(storage.page, Math.ceil(matched.length / PAGE_SIZE) - 1));
    let nextRefresh = Math.min(
        mode === "rotate" && pinned.length > PIN_SLIDES ? (pinWindow + 1) * 8 * PIN_SLIDES : Infinity,
        storage.pending ? Math.ceil(storage.pending.until / 1000) : Infinity
    );
    for (const note of completed) nextRefresh = Math.min(nextRefresh, note.done_at + RETENTION);
    return {
        storage, current, island, active, completed, matched, pending, pinned, editDraft,
        offset: (input.tz?.offset_minutes ?? 0) * 60, now,
        nextRefresh: Number.isFinite(nextRefresh) ? nextRefresh : undefined,
        alert: full ? "便签存储已满，无法保存本次修改"
            : bytes >= STORE_WARNING ? "便签较多，可到插件详情导出备份" : undefined
    };
}

function toStatus(state) {
    const { storage, current, active, completed, matched } = state;
    const status = {
        state: "idle", label: "便签本",
        summary: storage.completed ? `已完成 ${completed.length} 条`
            : active.length ? `${active.length} 条便签` : "还没有便签",
        alert: state.alert
    };

    const back = { id: "back", label: "返回" };
    const noteField = { key: "note", label: "新便签", max: 200, multiline: true };
    if (storage.view === "paste") {
        status.fields = [{ ...noteField, label: "粘贴内容" }];
        status.actions = [{ id: "add-pasted", label: "添加粘贴" }, back];
    } else if (storage.view === "manage" && current) {
        status.fields = [{ ...noteField, key: "edit_note", label: "编辑正文", value: editorText(state.editDraft ?? current.text) }];
        status.actions = [{ id: "save", label: "保存" }];
    } else {
        status.fields = [{ key: "note", label: "新便签", max: 200 },
            { key: "search", label: "搜索便签", value: storage.search, max: 80 }];
        status.actions = [{ id: "add", label: "＋ 添加" }, { id: "search", label: "搜索" }];
        if (storage.search && !matched.length) status.summary = "没有匹配的便签";
    }
    return status;
}

function caption(value, x, y, size, fill, extra = {}) {
    return { text: value, at: [x, y], size, fill, ...extra };
}

function noteColor(note) {
    const color = note.color;
    return typeof color === "string" && color.length === 7 && color[0] === "#"
        && [...color.slice(1).toLowerCase()].every(ch => "0123456789abcdef".includes(ch))
        ? color : COLORS[note.source] ?? COLORS.handwritten;
}

function noteTime(note, state) {
    const timestamp = note.created_at + state.offset;
    const days = Math.floor((state.now + state.offset) / DAY) - Math.floor(timestamp / DAY);
    const local = new Date(timestamp * 1000);
    const two = value => String(value).padStart(2, "0");
    const time = days === 0 ? `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`
        : `${two(local.getUTCMonth() + 1)}/${two(local.getUTCDate())}`;
    return { group: days === 0 ? "今天" : days === 1 ? "昨天" : "更早", time };
}

function button(label, x, y, w, hit, selected = false) {
    return [
        { rect: [x, y, w, 22], r: 7, fill: selected ? "#FFD25A" : "$card", hit, hover: { fill: selected ? "#FFE58A" : "$track" } },
        caption(label, x + w / 2, y + 15, 10, selected ? "#2A2410" : "$text", { align: "center", max_width: w - 6 })
    ];
}

function paperButton(x, path, hit, hint, selected = false) {
    return { translate: [x, 148], group: [
        { rect: [0, 0, 26, 26], r: 8, fill: selected ? "#214964" : "#2A241023", hit,
            hover: { fill: selected ? "#1A3A51" : "#2A241040", hint } },
        { path, stroke: selected ? ISLAND_BLUE : "#2A2410", width: 1.45, cap: "round" }
    ] };
}

function paperPushpin(pinned) {
    return [
        { rect: [130, 13, 21, 21], r: 6, fill: pinned ? "#2A241023" : "#00000000", hit: { action: "pin" },
            hover: { fill: "#2A241040", hint: pinned ? "取消置顶" : "置顶便签" } },
        { path: "M137 17H144L143 22L146 25H135L138 22Z M140.5 25V30",
            stroke: "#705727", width: 1.25, cap: "round", ...(pinned ? { fill: "#705727" } : {}) }
    ];
}

function drawPaper(state) {
    const { current, storage, matched } = state;
    if (!current) {
        return [
            { rect: [0, 8, 160, 174], r: 12, fill: "$card" },
            { rect: [67, 53, 27, 32], r: 5, fill: "#FFD25A" },
            { line: [74, 64, 86, 64], stroke: "#765D24", width: 1.4, cap: "round" },
            { line: [74, 71, 82, 71], stroke: "#765D24", width: 1.4, cap: "round" },
            caption(storage.completed ? "还没有已完成便签" : "还没有便签", 80, 109, 13, "$text", { align: "center", weight: 700 }),
            caption(storage.completed ? "完成的便签会显示在这里" : "在下方输入，记下一笔", 80, 132, 10, "$muted", { align: "center" })
        ];
    }
    const [first, ...rest] = current.text.split("\n");
    const rows = Math.max(1, Math.ceil([...first].length / 10));
    const rowCount = rest.reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / 12)), 0);
    const time = noteTime(current, state);
    const bodyHeight = 103;
    const contentHeight = 6 + rows * 17 + (rest.length ? 5 + rowCount * 15 : 0);
    const body = {
        id: `paper-text-${current.id}`, clip: [12, 33, 137, bodyHeight],
        group: [
            caption(first, 12, 47, 13, "#2A2410", { max_width: 136, lines: rows, weight: 700 }),
            ...(rest.length ? [caption(rest.join("\n"), 12, 47 + rows * 17, 11, "#2A2410", { max_width: 136, lines: rowCount })] : [])
        ]
    };
    if (contentHeight > bodyHeight) body.scroll = { axis: "y", content: contentHeight };
    const resident = state.island.some(note => note.id === current.id);
    const actions = current.done_at
        ? button("恢复便签", 46, 148, 72, { action: "restore" })
        : [
            paperButton(46, "M6 13L11 18L20 8", { action: "done" }, "完成"),
            paperButton(79, "M7 10H19Q21 10 21 12V15Q21 17 19 17H7Q5 17 5 15V12Q5 10 7 10Z",
                { action: "pin-island" }, resident ? "取消常驻" : "设为常驻", resident),
            paperButton(113, "M6 16L6 20L10 20L20 10L16 6L6 16Z M14 8L18 12", { action: "manage" }, "编辑便签")
        ];
    const start = storage.page * PAGE_SIZE;
    // 同页候选纸片在卡片外等待，通过相同的节点 ID 平移进纸堆。
    const waiting = matched.slice(start, start + PAGE_SIZE)
        .filter(note => note.id !== current.id)
        .map(note => ({
            id: `paper-${note.id}`, translate: [174, 0], opacity: 0,
            animate: PAPER_TRANSITION, group: []
        }));
    return [
        { translate: [11, 14], rotate: 3, group: [{ rect: [0, 0, 155, 174], r: 12, fill: "#3A3320" }] },
        { translate: [3, 15], rotate: -2, group: [{ rect: [0, 0, 156, 172], r: 12, fill: "#5A4D24" }] },
        {
            clip: [0, 0, 174, 193], group: [
                {
                    id: `paper-${current.id}`, animate: PAPER_TRANSITION, group: [
                        { rect: [0, 7, 160, 175], r: 12, fill: noteColor(current), shadow: "md" },
                        caption(`${time.group === "更早" ? "" : time.group + " "}${time.time}`, 12, 26, 9.5, "#755D2E"),
                        ...(current.done_at ? [] : paperPushpin(current.pinned)),
                        body,
                        paperButton(13, "M10 10H19V19H10Z M16 9V6H6V16H9", { copy: current.text }, "复制"),
                        ...actions
                    ]
                },
                ...waiting
            ]
        }
    ];
}

function drawEditor({ current }) {
    const activeColor = noteColor(current);
    const nodes = [
        caption("编辑便签", 0, 20, 14, "$text", { weight: 700 }),
        caption("颜色", 244, 20, 10, "$muted"),
        { rect: [0, 31, 387, 153], r: 9, fill: "$card", stroke: "$track" },
        ...button("保存", 0, 195, 49, { action: "save" }, true),
        ...button("返回", 56, 195, 49, { action: "back" }),
        ...button("删除", 338, 195, 49, { action: "delete" })
    ];
    COLOR_OPTIONS.forEach(([key, label, color], index) => {
        const x = 273 + index * 29;
        const selected = color === activeColor;
        nodes.push({ rect: [x, 4, 26, 23], r: 6, fill: color, hit: { action: `color-${key}` },
            ...(selected ? { stroke: "$text", width: 1.5 } : {}), hover: { hint: label } });
        if (selected) nodes.push({ path: `M${x + 7} 15L${x + 11} 19L${x + 19} 11`,
            stroke: "#2A2410", width: 1.5, cap: "round" });
    });
    if (current.done_at) {
        nodes.push(...button("恢复便签", 112, 195, 66, { action: "restore" }));
    } else if (current.pinned) {
        nodes.push(...button("上移", 112, 195, 41, { action: "pin-up" }),
            ...button("下移", 160, 195, 41, { action: "pin-down" }));
    }
    return { height: 227, nodes };
}

function quickFields({ storage, current }) {
    return storage.view !== "paste" && !(storage.view === "manage" && current);
}

function drawComposer() {
    return [
        { rect: [0, 206, 160, 24], r: 8, fill: "$card", stroke: "$track" },
        { rect: [136, 208, 21, 20], r: 6, fill: "#FFD25A", hit: { action: "add" }, hover: { fill: "#FFE58A" } },
        { path: "M142 218H151M146.5 213.5V222.5", stroke: "#2A2410", width: 1.55, cap: "round" }
    ];
}

function drawList(state) {
    const { storage, current, island, matched, completed, pinned } = state;
    const search = quickFields(state);
    const top = search ? 36 : 7;
    const nodes = [
        ...button("未完成", 180, top, 53, { action: "active" }, !storage.completed),
        ...button(`已完成 ${completed.length}`, 237, top, 69, { action: "completed" }, storage.completed)
    ];
    if (search) {
        nodes.push(
            { rect: [180, 7, 207, 24], r: 8, fill: "$card" },
            { rect: [181, 7, 21, 24], r: 7, fill: "#00000000", hit: { action: "search" }, hover: { fill: "$track" } },
            { circle: [190, 18, 3.3], stroke: "$muted", width: 1.3 },
            { line: [192.5, 20.5, 195, 23], stroke: "$muted", width: 1.3, cap: "round" },
            ...button("粘贴", 310, top, 37, { action: "paste" })
        );
    }
    const start = storage.page * PAGE_SIZE;
    const rows = [];
    let section;
    let y = 0;
    for (const note of matched.slice(start, start + PAGE_SIZE)) {
        const timestamp = noteTime(note, state);
        const group = note.done_at ? "已完成" : note.pinned ? "置顶" : timestamp.group;
        if (group !== section) {
            rows.push(caption(group === "置顶" ? `置顶 · ${pinned.length}` : group, 3, y + 11, 9, "$muted"));
            section = group;
            y += 16;
        }
        rows.push(
            { rect: [0, y, 203, 21], r: 7, fill: note.id === current?.id ? "$card" : "#00000000",
                hit: { action: `select-${note.id}` }, hover: { fill: "$track" } },
            { rect: [5, y + 4, 4, 13], r: 2, fill: noteColor(note) },
            caption(singleLine(note.text.split("\n")[0], 27) || "便签", 15, y + 14.5, 11, "$text",
                { max_width: 142, weight: note.pinned ? 700 : 400 }),
            caption(timestamp.time, 196, y + 14, 9, "$muted", { align: "right" })
        );
        if (island.some(item => item.id === note.id)) {
            rows.push({ rect: [159, y + 8, 8, 4], r: 2, fill: ISLAND_BLUE });
        }
        y += 23;
    }
    const listTop = top + 28;
    const listHeight = (state.pending ? 189 : 223) - listTop;
    if (rows.length) {
        const list = { id: `notes-scroll-${storage.completed ? "done" : "active"}-${storage.page}`,
            translate: [181, listTop], clip: [0, 0, 205, listHeight], group: rows };
        if (y > listHeight) list.scroll = { axis: "y", content: y };
        nodes.push(list);
    } else {
        nodes.push(caption(storage.search ? "没有匹配的便签" : "这里还没有便签", 184, listTop + 22, 11, "$muted"));
    }
    if (storage.page > 0) nodes.push(...button("‹", 351, top, 16, { action: "previous" }));
    if (start + PAGE_SIZE < matched.length) nodes.push(...button("›", 371, top, 16, { action: "next" }));
    return nodes;
}

function toPinned({ island }) {
    if (!island.length) return null;
    const slides = island.map(note => {
        const label = singleLine(note.text, 200) || "便签";
        return {
            width: 150, fit_width: true, nodes: [
                { translate: [1, 6], rotate: -6, group: [{ rect: [0, 0, 9, 11], r: 2, fill: noteColor(note) }] },
                { clip: [15, 0, 135, 22], group: [
                    caption(label, 15, 15.5, 11.5, "$text", {
                        id: `pin-${note.id}`, max_width: 135,
                        loop: { kind: "flow", period_ms: 4900 }
                    })
                ] }
            ]
        };
    });
    return { canvas: slides.length === 1 ? slides[0] : slides };
}

function toCanvas(state) {
    if (state.storage.view === "manage" && state.current) return drawEditor(state);
    const nodes = [...drawPaper(state), ...(quickFields(state) ? drawComposer() : []), ...drawList(state)];
    const binds = {};
    if (state.pending) {
        const expiry = Math.ceil(state.storage.pending.until / 1000);
        binds.undo = { progress: [expiry - 1, expiry] };
        const title = singleLine(state.pending.text, 21);
        nodes.push({
            id: `undo-${state.pending.id}`, opacity: { bind: "undo", map: [1, 0] }, group: [
                { rect: [180, 197, 207, 25], r: 8, fill: "$card" },
                { rect: [185, 203, 4, 13], r: 2, fill: noteColor(state.pending) },
                caption(title, 195, 213, 10.5, "$muted", { max_width: 140 }),
                { line: [195, 209, 195 + Math.min(138, [...title].length * 9), 209], stroke: "$muted" },
                { rect: [339, 197, 48, 25], r: 8, fill: "#00000000", hit: { action: "undo" } },
                caption("撤销", 363, 213, 10.5, "#FFD25A", { align: "center", weight: 700 })
            ]
        });
    }
    return { height: 230, nodes, binds };
}

function refresh(input) {
    const state = computeState(input);
    return {
        status: toStatus(state), canvas: toCanvas(state), pinned: toPinned(state),
        storage: state.storage, next_refresh_at: state.nextRefresh
    };
}

function action(input) {
    return refresh(input);
}

function event(input) {
    return refresh(input);
}
