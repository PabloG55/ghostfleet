import { a as S, i as R, n as A, r as _, t as u } from "./preact.js";
import { clockLabel } from "./grid.js";
//#region web/src/screens.jsx
var VERB = /^(\S+) (.+)$/;
function Btn({ label, onClick, cls = "" }) {
	const m = VERB.exec(label);
	if (m && [...m[1]].length <= 2) return /* @__PURE__ */ u("button", {
		class: (cls + " k").trim(),
		onClick,
		children: [/* @__PURE__ */ u("b", { children: m[1] }), " " + m[2]]
	});
	return /* @__PURE__ */ u("button", {
		class: cls || null,
		onClick,
		children: label
	});
}
var ICONS = {
	enter: ["M5 12h14M12 5l7 7-7 7"],
	clock: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 7v5l3 2"],
	plus: ["M12 5v14M5 12h14"],
	tree: ["M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M6 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M18 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M6 8.5v7M8.5 6h4a3 3 0 0 1 3 3v1M8.5 18h4a3 3 0 0 0 3-3v-1"],
	folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
	gear: ["M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.5a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9.5a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
	more: ["M6 12h.01M12 12h.01M18 12h.01"]
};
function Icon({ name }) {
	const ds = ICONS[name];
	if (!ds) return null;
	return /* @__PURE__ */ u("svg", {
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
		focusable: "false",
		children: ds.map((d, i) => /* @__PURE__ */ u("path", { d }, i))
	});
}
function VerbBtn({ verb, label, icon, onClick, cls = "" }) {
	return /* @__PURE__ */ u("button", {
		class: cls || null,
		"data-verb": verb,
		onClick,
		title: label,
		"aria-label": label,
		children: [/* @__PURE__ */ u(Icon, { name: icon }), /* @__PURE__ */ u("span", {
			class: "vl",
			children: label
		})]
	});
}
function Header({ scope, mode, stale, counts }) {
	return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
		class: "hdr",
		children: [
			/* @__PURE__ */ u("span", {
				class: "name",
				children: "ghostfleet"
			}),
			/* @__PURE__ */ u("span", {
				class: "scope",
				children: scope
			}),
			/* @__PURE__ */ u("span", {
				class: "mode " + mode.kind,
				title: mode.detail || null,
				children: mode.text
			}),
			counts && counts.length ? /* @__PURE__ */ u("span", {
				class: "counts",
				children: counts.map((s, i) => /* @__PURE__ */ u("span", {
					style: s.color ? `color:${s.color}` : null,
					children: s.text
				}, i))
			}) : null
		]
	}), stale ? /* @__PURE__ */ u("div", {
		class: "stale",
		children: `⚠ offline — last fetched ${clockLabel(stale)}`
	}) : null] });
}
function ProfileTabs({ tabs, onTab }) {
	if (!tabs || tabs.length < 2) return null;
	return /* @__PURE__ */ u("div", {
		class: "seg tabs",
		children: tabs.map((t) => /* @__PURE__ */ u(Btn, {
			label: t.need ? `${t.name} ●${t.need}` : t.name,
			cls: t.on ? "on" : "",
			onClick: () => onTab(t.name)
		}, t.name))
	});
}
function CountStrip({ strip }) {
	if (!strip || !strip.length) return null;
	return /* @__PURE__ */ u("div", {
		class: "strip",
		children: strip.map((t) => /* @__PURE__ */ u("div", {
			class: "stat" + (t.n ? " on" : ""),
			style: `--c:${t.color}`,
			children: [/* @__PURE__ */ u("div", {
				class: "n",
				children: String(t.n)
			}), /* @__PURE__ */ u("div", {
				class: "l",
				children: t.label
			})]
		}, t.label))
	});
}
function ConfirmBar({ confirm }) {
	if (!confirm) return null;
	return /* @__PURE__ */ u("div", {
		class: "confirm " + confirm.cls,
		children: [
			/* @__PURE__ */ u("span", {
				class: "q",
				children: " " + confirm.q
			}),
			/* @__PURE__ */ u("span", {
				class: "keys",
				children: "  " + confirm.keys
			}),
			confirm.buttons.length ? /* @__PURE__ */ u("div", {
				class: "row",
				children: confirm.buttons.map((b, i) => /* @__PURE__ */ u(Btn, {
					label: b.label,
					cls: b.cls,
					onClick: b.onClick
				}, i))
			}) : null
		]
	});
}
function CardList({ nodes, listRef }) {
	const box = A(null);
	_(() => {
		listRef(box.current);
		return () => listRef(null);
	}, []);
	_(() => {
		if (box.current) box.current.replaceChildren(...nodes);
	});
	return /* @__PURE__ */ u("div", {
		class: "cards",
		ref: box
	});
}
function CardScreen({ scope, mode, stale, counts, band, confirm, cards, listRef, toast, verbs, hint }) {
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope,
			mode,
			stale,
			counts
		}),
		band,
		/* @__PURE__ */ u(ConfirmBar, { confirm }),
		/* @__PURE__ */ u(CardList, {
			nodes: cards,
			listRef
		}),
		toast ? /* @__PURE__ */ u("div", {
			class: ("toast " + (toast.kind || "")).trim(),
			children: toast.text
		}) : null,
		/* @__PURE__ */ u("div", {
			class: "verbs",
			children: verbs.map((v) => /* @__PURE__ */ u(VerbBtn, {
				verb: v.verb,
				label: v.label,
				icon: v.icon,
				cls: v.cls,
				onClick: v.onClick
			}, v.verb))
		}),
		/* @__PURE__ */ u("div", {
			class: "hint",
			children: hint
		})
	] });
}
function ProjectsScreen(p) {
	return /* @__PURE__ */ u(CardScreen, {
		...p,
		band: /* @__PURE__ */ u(ProfileTabs, {
			tabs: p.tabs,
			onTab: p.onTab
		})
	});
}
function GridScreen(p) {
	return /* @__PURE__ */ u(CardScreen, {
		...p,
		band: /* @__PURE__ */ u(CountStrip, { strip: p.strip })
	});
}
var SCREENS = {
	projects: ProjectsScreen,
	grid: GridScreen
};
function mount(container, screen, props) {
	const S = SCREENS[screen];
	if (!S) throw new Error(`screens.mount: no such screen '${screen}'`);
	R(/* @__PURE__ */ u(S, { ...props }, screen), container);
}
function unmount(container) {
	R(null, container);
}
//#endregion
export { mount, unmount };
