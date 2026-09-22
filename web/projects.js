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
			children: p.verbs.map((v, i) => /* @__PURE__ */ u(Btn, {
				label: v.label,
				cls: v.cls,
				onClick: v.onClick
			}, i))
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
