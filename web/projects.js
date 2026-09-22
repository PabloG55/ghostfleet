import { a as S, i as R, n as A, r as _, t as u } from "./preact.js";
import { clockLabel } from "./grid.js";
//#region web/src/projects.jsx
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
function Header({ scope, mode, stale }) {
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
			})
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
function ProjectsScreen(p) {
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope: p.scope,
			mode: p.mode,
			stale: p.stale
		}),
		/* @__PURE__ */ u(ProfileTabs, {
			tabs: p.tabs,
			onTab: p.onTab
		}),
		/* @__PURE__ */ u(ConfirmBar, { confirm: p.confirm }),
		/* @__PURE__ */ u(CardList, {
			nodes: p.cards,
			listRef: p.listRef
		}),
		p.toast ? /* @__PURE__ */ u("div", {
			class: ("toast " + (p.toast.kind || "")).trim(),
			children: p.toast.text
		}) : null,
		/* @__PURE__ */ u("div", {
			class: "verbs",
			children: p.verbs.map((v) => /* @__PURE__ */ u(VerbBtn, {
				verb: v.verb,
				label: v.label,
				icon: v.icon,
				cls: v.cls,
				onClick: v.onClick
			}, v.verb))
		}),
		/* @__PURE__ */ u("div", {
			class: "hint",
			children: p.hint
		})
	] });
}
function mount(container, props) {
	R(/* @__PURE__ */ u(ProjectsScreen, { ...props }), container);
}
function unmount(container) {
	R(null, container);
}
//#endregion
export { mount, unmount };
