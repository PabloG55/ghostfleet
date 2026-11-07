import { a as h, i as d, n as A, o as R, r as _, s as S, t as u } from "./preact.js";
import { clockLabel } from "./grid.js";
//#region web/src/reviews.jsx
var MEANT = /^(Document|XHR|Fetch)$/i;
var reqCls = (r) => r.failed || r.status >= 400 ? "bad" : r.status >= 300 ? "warn" : "ok";
var clock = (s) => {
	s = Math.max(0, Math.round(Number(s) || 0));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function ReviewsScreen(p) {
	return /* @__PURE__ */ u(CardScreen, {
		...p,
		band: null
	});
}
function Req({ r }) {
	return /* @__PURE__ */ u("div", {
		class: "rv-req " + reqCls(r),
		children: [
			/* @__PURE__ */ u("span", {
				class: "m",
				children: r.method
			}),
			/* @__PURE__ */ u("span", {
				class: "s",
				children: r.failed ? r.failed : r.status ?? "—"
			}),
			/* @__PURE__ */ u("span", {
				class: "u",
				children: r.url
			})
		]
	});
}
function Requests({ list, t }) {
	const calls = list.filter((r) => MEANT.test(r.type || ""));
	const assets = list.filter((r) => !MEANT.test(r.type || ""));
	const bad = calls.filter((r) => r.failed || r.status >= 400).length;
	const assetBad = assets.filter((r) => r.failed || r.status >= 400).length;
	return /* @__PURE__ */ u("div", {
		class: "rv-reqs",
		children: [
			/* @__PURE__ */ u("div", {
				class: "rv-cap",
				children: [/* @__PURE__ */ u("span", { children: t.calls(calls.length) }), bad ? /* @__PURE__ */ u("span", {
					class: "bad",
					children: t.failed(bad)
				}) : /* @__PURE__ */ u("span", { children: t.noneFailed })]
			}),
			calls.length ? calls.map((r, i) => /* @__PURE__ */ u(Req, { r }, i)) : /* @__PURE__ */ u("div", {
				class: "rv-none",
				children: t.noCalls
			}),
			assets.length ? /* @__PURE__ */ u("details", {
				class: "rv-assets",
				open: assetBad > 0,
				children: [/* @__PURE__ */ u("summary", { children: t.assets(assets.length, assetBad) }), assets.map((r, i) => /* @__PURE__ */ u(Req, { r }, i))]
			}) : null
		]
	});
}
function Note({ value, placeholder, onInput, label }) {
	return /* @__PURE__ */ u("textarea", {
		class: "rv-note",
		rows: 2,
		value,
		placeholder,
		"aria-label": label,
		onInput: (e) => onInput(e.currentTarget.value)
	});
}
function Step({ s, run, t, v, cur, onSeek, onStep, onStepNote, onChapterNote }) {
	const recorded = run.kind === "recorded";
	const flagged = !!(s.notes && s.notes.length);
	const mark = recorded ? null : v[String(s.n)] || {};
	const note = recorded ? (v.chapters || {})[String(s.n)] || "" : mark.note || "";
	return /* @__PURE__ */ u("section", {
		class: "rv-step" + (flagged ? " flag" : "") + (cur ? " cur" : ""),
		"data-n": s.n,
		children: [
			/* @__PURE__ */ u("div", {
				class: "rv-sh",
				children: [
					/* @__PURE__ */ u("span", {
						class: "rv-n",
						children: String(s.n).padStart(2, "0")
					}),
					/* @__PURE__ */ u("span", {
						class: "rv-sn",
						children: s.name
					}),
					recorded && s.start != null ? /* @__PURE__ */ u("button", {
						type: "button",
						class: "rv-t",
						onClick: () => onSeek(s),
						"aria-label": t.playFrom(s.name, clock(s.start)),
						children: "▶ " + clock(s.start)
					}) : null
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "rv-url",
				children: s.url || t.noPage
			}),
			s.title ? /* @__PURE__ */ u("div", {
				class: "rv-ttl",
				children: s.title
			}) : null,
			s.expect && (s.expect.found || !(s.notes || []).length) ? /* @__PURE__ */ u("div", {
				class: "rv-line " + (s.expect.found ? "ok" : "bad"),
				children: t.expect(s.expect)
			}) : null,
			(s.notes || []).map((n, i) => /* @__PURE__ */ u("div", {
				class: "rv-line warn",
				children: n
			}, i)),
			s.src ? /* @__PURE__ */ u("img", {
				class: "rv-shot",
				src: s.src,
				alt: s.name,
				loading: "lazy"
			}) : null,
			/* @__PURE__ */ u(Requests, {
				list: s.requests || [],
				t
			}),
			recorded ? /* @__PURE__ */ u(Note, {
				value: note,
				label: t.chapterNoteLabel(s.n),
				placeholder: flagged ? t.flagNotePlaceholder : t.chapterPlaceholder,
				onInput: (x) => onChapterNote(s.n, x)
			}) : /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
				class: "seg rv-mark",
				role: "group",
				"aria-label": t.markLabel(s.n),
				children: t.marks.map((m) => /* @__PURE__ */ u("button", {
					type: "button",
					class: (mark.v === m.v ? "on " : "") + m.v,
					"aria-pressed": mark.v === m.v ? "true" : "false",
					onClick: () => onStep(s.n, mark.v === m.v ? "" : m.v),
					children: m.label
				}, m.v))
			}), /* @__PURE__ */ u(Note, {
				value: note,
				label: t.stepNoteLabel(s.n),
				placeholder: flagged ? t.reasonPlaceholder : t.notePlaceholder,
				onInput: (x) => onStepNote(s.n, x)
			})] })
		]
	});
}
function Player({ run, t, video, cur, setCur, onSeek }) {
	const steps = run.steps.filter((s) => s.start != null);
	const total = run.duration || (steps.length ? steps[steps.length - 1].end : 0) || 1;
	h(() => {
		const el = video.current;
		if (!el) return void 0;
		const tick = () => {
			const tm = el.currentTime;
			let k = 0;
			steps.forEach((s, i) => {
				if (tm + .05 >= s.start) k = i;
			});
			setCur(steps[k] ? steps[k].n : 0);
		};
		el.addEventListener("timeupdate", tick);
		el.addEventListener("seeked", tick);
		return () => {
			el.removeEventListener("timeupdate", tick);
			el.removeEventListener("seeked", tick);
		};
	}, [run.id]);
	const now = steps.find((s) => s.n === cur) || steps[0];
	return /* @__PURE__ */ u("div", {
		class: "rv-player",
		children: [
			/* @__PURE__ */ u("video", {
				ref: video,
				class: "rv-video",
				src: run.videoSrc,
				controls: true,
				playsInline: true,
				preload: "metadata"
			}),
			/* @__PURE__ */ u("div", {
				class: "rv-strip",
				role: "group",
				"aria-label": t.chapters,
				children: steps.map((s) => /* @__PURE__ */ u("button", {
					type: "button",
					style: `flex-grow:${Math.max(.2, ((s.end ?? total) - s.start) / total)}`,
					class: "rv-ch" + (s.notes && s.notes.length ? " flag" : "") + (s.n === cur ? " on" : ""),
					"aria-current": s.n === cur ? "step" : void 0,
					"aria-label": t.playFrom(s.name, clock(s.start)),
					title: s.name,
					onClick: () => onSeek(s),
					children: String(s.n)
				}, s.n))
			}),
			now ? /* @__PURE__ */ u("div", {
				class: "rv-now",
				children: [
					/* @__PURE__ */ u("b", { children: String(now.n).padStart(2, "0") }),
					" ",
					now.name,
					" ",
					/* @__PURE__ */ u("span", { children: clock(now.start) })
				]
			}) : null
		]
	});
}
function Provenance({ run, t }) {
	const p = run.provenance || {};
	const rows = [
		[t.prov.commit, p.commit ? `${p.commit}${p.dirty ? " " + t.dirty : ""}` : "—"],
		[t.prov.base, p.base || "—"],
		[t.prov.viewport, p.viewport ? `${p.viewport.width}×${p.viewport.height}` : "—"],
		[t.prov.at, t.when(run.at)],
		[t.prov.session, p.session || "—"],
		[t.prov.run, run.id]
	];
	return /* @__PURE__ */ u("dl", {
		class: "rv-prov",
		children: rows.map(([k, v]) => /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("dt", { children: k }), /* @__PURE__ */ u("dd", { children: v })] }, k))
	});
}
function Bar({ run, t, v, gate, save, onFlow, onRestOk, onRetry }) {
	const fv = (v.flow || {}).v || "";
	const unmarked = run.kind === "recorded" ? 0 : run.steps.filter((s) => !(v[String(s.n)] || {}).v).length;
	return /* @__PURE__ */ u("div", {
		class: "rv-bar",
		children: [/* @__PURE__ */ u("div", {
			class: "rv-gate " + (gate.cls || "warn"),
			children: [
				/* @__PURE__ */ u("span", {
					class: "rv-dot",
					"aria-hidden": "true"
				}),
				/* @__PURE__ */ u("span", {
					class: "rv-gt",
					children: gate.text
				}),
				save === "failed" ? /* @__PURE__ */ u("button", {
					type: "button",
					class: "rv-retry",
					onClick: onRetry,
					children: t.retry
				}) : /* @__PURE__ */ u("span", {
					class: "rv-saved",
					children: save ? t.save[save] : ""
				})
			]
		}), run.kind === "recorded" ? /* @__PURE__ */ u("div", {
			class: "rv-acts",
			children: [/* @__PURE__ */ u("button", {
				type: "button",
				class: "danger" + (fv === "reject" ? " on" : ""),
				"aria-pressed": fv === "reject" ? "true" : "false",
				title: t.keys.reject,
				onClick: () => onFlow(fv === "reject" ? "" : "reject"),
				children: t.reject
			}), /* @__PURE__ */ u("button", {
				type: "button",
				class: "go" + (fv === "approve" ? " on" : ""),
				"aria-pressed": fv === "approve" ? "true" : "false",
				title: t.keys.approve,
				onClick: () => onFlow(fv === "approve" ? "" : "approve"),
				children: fv === "approve" ? t.approved : t.approve
			})]
		}) : unmarked ? /* @__PURE__ */ u("div", {
			class: "rv-acts",
			children: /* @__PURE__ */ u("button", {
				type: "button",
				class: "go",
				onClick: onRestOk,
				children: t.restOk(unmarked)
			})
		}) : null]
	});
}
function ReviewScreen(p) {
	const { run, t } = p;
	const video = A(null);
	const [picked, setCur] = d(0);
	const cur = picked || (run && run.kind === "recorded" ? (run.steps.find((s) => s.start != null) || {}).n || 0 : 0);
	const body = A(null);
	h(() => {
		if (!p.onPlayer) return void 0;
		p.onPlayer({
			toggle: () => {
				const el = video.current;
				if (el) el.paused ? el.play().catch(() => {}) : el.pause();
			},
			step: (d) => {
				const st = run ? run.steps.filter((s) => s.start != null) : [];
				const i = Math.max(0, st.findIndex((s) => s.n === cur));
				const s = st[Math.min(st.length - 1, Math.max(0, i + d))];
				if (s) seek(s);
			}
		});
		return () => p.onPlayer(null);
	});
	const seek = (s) => {
		const el = video.current;
		if (!el || s.start == null) return;
		el.currentTime = s.start + .01;
		setCur(s.n);
		el.play().catch(() => {});
		try {
			el.scrollIntoView({
				block: "nearest",
				behavior: "smooth"
			});
		} catch {}
	};
	if (!run) return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u(Header, {
		scope: p.scope,
		mode: p.mode,
		stale: p.stale,
		onBack: p.onBack
	}), /* @__PURE__ */ u("div", {
		class: "rv-body",
		children: /* @__PURE__ */ u("div", {
			class: "rv-wait",
			children: p.err || t.loading
		})
	})] });
	const v = p.verdict || {};
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope: p.scope,
			mode: p.mode,
			stale: p.stale,
			onBack: p.onBack
		}),
		/* @__PURE__ */ u("div", {
			class: "rv-body",
			ref: body,
			children: /* @__PURE__ */ u("div", {
				class: "rv-col",
				children: [
					/* @__PURE__ */ u("div", {
						class: "rv-head",
						children: [/* @__PURE__ */ u("div", {
							class: "rv-br",
							children: run.branch || t.noBranch
						}), /* @__PURE__ */ u("div", {
							class: "rv-meta",
							children: p.where
						})]
					}),
					run.kind === "recorded" ? /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u(Player, {
						run,
						t,
						video,
						cur,
						setCur,
						onSeek: seek
					}), /* @__PURE__ */ u(Note, {
						value: (v.flow || {}).note || "",
						label: t.flowNoteLabel,
						placeholder: t.flowPlaceholder,
						onInput: p.onFlowNote
					})] }) : null,
					/* @__PURE__ */ u("h2", {
						class: "rv-h",
						children: t.steps(run.steps.length)
					}),
					run.steps.map((s) => /* @__PURE__ */ u(Step, {
						s,
						run,
						t,
						v,
						cur: run.kind === "recorded" && s.n === cur,
						onSeek: seek,
						onStep: p.onStep,
						onStepNote: p.onStepNote,
						onChapterNote: p.onChapterNote
					}, s.n)),
					/* @__PURE__ */ u("h2", {
						class: "rv-h",
						children: t.provenance
					}),
					/* @__PURE__ */ u(Provenance, {
						run,
						t
					})
				]
			})
		}),
		p.toast ? /* @__PURE__ */ u("div", {
			class: ("toast " + (p.toast.kind || "")).trim(),
			children: p.toast.text
		}) : null,
		/* @__PURE__ */ u(Bar, {
			run,
			t,
			v,
			gate: p.gate,
			save: p.save,
			onFlow: p.onFlow,
			onRestOk: p.onRestOk,
			onRetry: p.onRetry
		})
	] });
}
//#endregion
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
	more: ["M6 12h.01M12 12h.01M18 12h.01"],
	close: ["M6 6l12 12M18 6 6 18"]
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
function Header({ scope, mode, stale, counts, onMore, onBack }) {
	return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
		class: "hdr",
		children: [
			onBack ? /* @__PURE__ */ u(Btn, {
				label: "‹",
				cls: "back",
				onClick: onBack
			}) : null,
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
function FindField({ find }) {
	if (!find) return null;
	return /* @__PURE__ */ u("div", {
		class: "find",
		children: [
			/* @__PURE__ */ u("input", {
				type: "search",
				value: find.q,
				placeholder: find.placeholder,
				"aria-label": find.placeholder,
				enterkeyhint: "search",
				autocomplete: "off",
				autocapitalize: "off",
				autocorrect: "off",
				spellcheck: false,
				onInput: (e) => find.onInput(e.currentTarget.value),
				onKeyDown: find.onKey
			}),
			/* @__PURE__ */ u("span", {
				class: "count",
				children: find.count
			}),
			find.q ? /* @__PURE__ */ u("button", {
				class: "clear",
				onClick: find.onClear,
				"aria-label": "clear the search",
				children: "×"
			}) : null
		]
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
			confirm.close ? /* @__PURE__ */ u("button", {
				type: "button",
				class: "sheet-x confirm-x",
				"aria-label": "close",
				title: "close · esc",
				onClick: confirm.close,
				children: /* @__PURE__ */ u(Icon, { name: "close" })
			}) : null,
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
function CardScreen({ scope, mode, stale, counts, onMore, onBack, band, confirm, cards, listRef, toast }) {
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope,
			mode,
			stale,
			counts,
			onMore,
			onBack
		}),
		band,
		/* @__PURE__ */ u(ConfirmBar, { confirm }),
		/* @__PURE__ */ u(CardList, {
			nodes: cards,
			listRef
		}),
		toast && toast.action ? /* @__PURE__ */ u("div", {
			class: ("toast act " + (toast.kind || "")).trim(),
			children: [/* @__PURE__ */ u("span", { children: toast.text }), /* @__PURE__ */ u("button", {
				onClick: toast.action.fn,
				children: toast.action.label
			})]
		}) : toast ? /* @__PURE__ */ u("div", {
			class: ("toast " + (toast.kind || "")).trim(),
			children: toast.text
		}) : null
	] });
}
function JarvisBar({ jarvis }) {
	if (!jarvis) return null;
	return /* @__PURE__ */ u("button", {
		class: ("jarvis-bar " + (jarvis.tone || "")).trim(),
		onClick: jarvis.onOpen,
		"aria-label": `${jarvis.title} — ${jarvis.sub}`,
		children: [
			/* @__PURE__ */ u("span", {
				class: "jt",
				children: jarvis.title
			}),
			/* @__PURE__ */ u("span", {
				class: "js",
				children: jarvis.sub
			}),
			/* @__PURE__ */ u("span", {
				class: "jgo",
				"aria-hidden": "true",
				children: "›"
			})
		]
	});
}
function NotifyBar({ notify }) {
	if (!notify) return null;
	return /* @__PURE__ */ u("div", {
		class: "notify-bar",
		children: [
			/* @__PURE__ */ u("span", {
				class: "nt",
				children: notify.text
			}),
			/* @__PURE__ */ u(Btn, {
				label: notify.enable,
				onClick: notify.onEnable,
				cls: "go"
			}),
			/* @__PURE__ */ u(Btn, {
				label: notify.later,
				onClick: notify.onLater
			})
		]
	});
}
function ProjectsScreen(p) {
	return /* @__PURE__ */ u(CardScreen, {
		...p,
		band: /* @__PURE__ */ u(S, { children: [
			/* @__PURE__ */ u(FindField, { find: p.find }),
			/* @__PURE__ */ u(NotifyBar, { notify: p.notify }),
			/* @__PURE__ */ u(JarvisBar, { jarvis: p.jarvis }),
			/* @__PURE__ */ u(ProfileTabs, {
				tabs: p.tabs,
				onTab: p.onTab
			})
		] })
	});
}
function GridScreen(p) {
	return /* @__PURE__ */ u(CardScreen, {
		...p,
		band: /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u(FindField, { find: p.find }), /* @__PURE__ */ u(CountStrip, { strip: p.strip })] })
	});
}
function QueueScreen(p) {
	return /* @__PURE__ */ u(CardScreen, {
		...p,
		band: null
	});
}
var SCREENS = {
	projects: ProjectsScreen,
	grid: GridScreen,
	queue: QueueScreen,
	reviews: ReviewsScreen,
	review: ReviewScreen
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
export { CardScreen, Header, mount, unmount };
