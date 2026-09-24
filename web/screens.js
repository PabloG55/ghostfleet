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
var ICONS = { more: ["M6 12h.01M12 12h.01M18 12h.01"] };
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
function Header({ scope, mode, stale, counts, onMore }) {
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
			}) : null,
			onMore ? /* @__PURE__ */ u("button", {
				class: "more",
				onClick: onMore,
				title: "actions",
				"aria-label": "actions",
				children: /* @__PURE__ */ u(Icon, { name: "more" })
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
function CardScreen({ scope, mode, stale, counts, onMore, band, confirm, cards, listRef, toast }) {
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope,
			mode,
			stale,
			counts,
			onMore
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
		}) : null
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
