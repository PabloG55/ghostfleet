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
function Step$1({ s, run, t, v, cur, onSeek, onStep, onStepNote, onChapterNote }) {
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
					run.steps.map((s) => /* @__PURE__ */ u(Step$1, {
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
//#region lib/automations-model.mjs
var EVENTS = {
	finished: {
		label: "finishes a turn",
		hint: "working → ready or idle",
		is: (a, b) => a === "working" && (b === "ready" || b === "idle")
	},
	"need-you": {
		label: "needs you",
		hint: "waiting on an answer or a permission",
		is: (a, b) => b === "need-you" && a !== "need-you"
	},
	started: {
		label: "starts working",
		hint: "a turn begins",
		is: (a, b) => b === "working" && a !== "working"
	},
	limit: {
		label: "hits a usage limit",
		hint: "the account ran out",
		is: (a, b) => b === "limit" && a !== "limit"
	},
	interrupted: {
		label: "is interrupted",
		hint: "the turn was cut off",
		is: (a, b) => b === "interrupted" && a !== "interrupted"
	}
};
var ACTIONS = {
	send: {
		label: "send a prompt",
		tool: "fleet_send",
		needs: [
			"project",
			"session",
			"prompt"
		]
	},
	spawn: {
		label: "start a session",
		tool: "fleet_spawn",
		needs: ["project", "name"],
		optional: ["prompt", "branch"],
		passkey: true
	},
	pause: {
		label: "pause",
		tool: "fleet_pause",
		needs: ["project", "session"]
	},
	resume: {
		label: "resume",
		tool: "fleet_resume",
		needs: ["project", "session"],
		optional: ["prompt"]
	},
	wake: {
		label: "wake",
		tool: "fleet_wake",
		needs: ["project", "session"]
	},
	interrupt: {
		label: "interrupt",
		tool: "fleet_interrupt",
		needs: ["project", "session"]
	},
	reopen: {
		label: "reopen",
		tool: "fleet_reopen",
		needs: ["project", "session"]
	},
	stop: {
		label: "stop",
		tool: "fleet_stop",
		needs: ["project", "session"],
		passkey: true
	},
	check: {
		label: "continue only if…",
		tool: null,
		needs: [
			"project",
			"session",
			"status"
		]
	},
	notify: {
		label: "tell me",
		tool: null,
		needs: ["text"]
	},
	wait: {
		label: "wait",
		tool: null,
		needs: ["minutes"]
	}
};
var STATES = [
	"need-you",
	"working",
	"ready",
	"parked",
	"idle",
	"starting",
	"unknown",
	"limit",
	"interrupted"
];
var DAY_NAMES = [
	"Sun",
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri",
	"Sat"
];
var EVENT_PROJECT = "{project}";
var EVENT_SESSION = "{session}";
var blankTrigger = (type = "schedule") => type === "event" ? {
	type: "event",
	event: "finished",
	project: "*",
	session: "*",
	cooldown: 10
} : {
	type: "schedule",
	mode: "days",
	at: "10:00",
	days: [
		1,
		2,
		3,
		4,
		5
	],
	date: "",
	minutes: 60
};
var blankStep = (action) => ({
	action,
	project: "",
	session: "",
	prompt: "",
	name: "",
	branch: "",
	minutes: action === "wait" ? 5 : 0,
	text: "",
	status: action === "check" ? ["need-you"] : []
});
var blankAutomation = () => ({
	id: null,
	name: "",
	enabled: true,
	trigger: blankTrigger("schedule"),
	steps: []
});
var needsPasskey = (a) => (a?.steps || []).some((s) => ACTIONS[s.action]?.passkey);
var everyWords = (m) => m % 1440 === 0 ? `${m / 1440} day${m > 1440 ? "s" : ""}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`;
function daysWords(days) {
	const s = [...days].sort().join(",");
	if (s === "0,1,2,3,4,5,6") return "every day";
	if (s === "1,2,3,4,5") return "weekdays";
	if (s === "0,6") return "weekends";
	return days.map((d) => DAY_NAMES[d]).join(", ");
}
function describeTrigger(t) {
	if (!t) return "";
	if (t.type === "event") return `when ${t.session && t.session !== "*" ? t.session : "any session"} ${!t.project || t.project === "*" ? "in any project" : `in ${t.project}`} ${EVENTS[t.event]?.label || t.event}`;
	if (t.mode === "once") return `once, ${t.date || "?"} at ${t.at}`;
	if (t.mode === "every") return `every ${everyWords(t.minutes)}`;
	return `${daysWords(t.days)} at ${t.at}`;
}
var where = (s) => `${s.session === "{session}" ? "the event's session" : s.session || "?"}${s.project && s.project !== "{project}" ? ` (${s.project})` : ""}`;
var clip = (v, n) => {
	const x = String(v || "");
	return x.length > n ? `${x.slice(0, n)}…` : x;
};
function describeStep(s) {
	const d = ACTIONS[s.action];
	if (!d) return s.action;
	switch (s.action) {
		case "send": return `send ${where(s)}: "${clip(s.prompt, 60)}"`;
		case "spawn": return `start session ${s.name || "?"} in ${s.project || "?"}${s.prompt ? " with a task" : ""}`;
		case "notify": return `tell me: "${clip(s.text, 60)}"`;
		case "wait": return `wait ${s.minutes} min`;
		case "check": return `continue only if ${where(s)} is ${(s.status || []).join(" or ") || "?"}`;
		default: return `${d.label} ${where(s)}`;
	}
}
//#endregion
//#region web/src/automations.jsx
var EVERY = [
	15,
	30,
	60,
	120,
	180,
	360,
	720,
	1440
];
var when = (ts) => (/* @__PURE__ */ new Date(ts * 1e3)).toLocaleString(void 0, {
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit"
});
var clone = (v) => JSON.parse(JSON.stringify(v));
function AutomationsScreen(p) {
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope: p.editing ? p.editing === "new" ? "— new automation" : "— edit automation" : "— automations",
			mode: p.mode,
			stale: p.stale,
			onBack: p.onBack
		}),
		/* @__PURE__ */ u("div", {
			class: "cards autos",
			children: p.data == null ? /* @__PURE__ */ u("p", {
				class: "autos-dim",
				children: "reading…"
			}) : p.editing ? /* @__PURE__ */ u(Editor, { ...p }, p.editing) : /* @__PURE__ */ u(List, { ...p })
		}),
		p.toast ? /* @__PURE__ */ u("div", {
			class: ("toast " + (p.toast.kind || "")).trim(),
			children: p.toast.text
		}) : null
	] });
}
function List({ data, onEdit, onSave, onDelete, onRun, onSeen }) {
	const list = data.automations || [];
	const unseen = (data.notices || []).filter((n) => !n.seen);
	return /* @__PURE__ */ u(S, { children: [
		unseen.length ? /* @__PURE__ */ u("section", {
			class: "autos-notices",
			children: [unseen.map((n) => /* @__PURE__ */ u("div", {
				class: `autos-notice k-${n.kind}`,
				children: [
					/* @__PURE__ */ u("span", {
						class: "autos-when",
						children: when(n.at)
					}),
					" ",
					n.text
				]
			}, n.id)), /* @__PURE__ */ u(Btn, {
				label: "seen",
				onClick: onSeen
			})]
		}) : null,
		/* @__PURE__ */ u("div", {
			class: "autos-top",
			children: /* @__PURE__ */ u(Btn, {
				label: "new automation",
				cls: "go",
				onClick: () => onEdit("new")
			})
		}),
		!list.length ? /* @__PURE__ */ u("p", {
			class: "autos-dim",
			children: "None yet. One is a trigger and some steps — for example \"weekdays at 09:00, send the lead of acme-api: review what is open\", or \"when any session in acme-web needs you, tell me\"."
		}) : null,
		list.map((a) => /* @__PURE__ */ u(Item, {
			a,
			onEdit,
			onSave,
			onDelete,
			onRun
		}, a.id)),
		(data.runs || []).length ? /* @__PURE__ */ u("section", {
			class: "autos-runs",
			children: [/* @__PURE__ */ u("h3", { children: "last runs" }), data.runs.map((r, i) => /* @__PURE__ */ u("details", {
				class: "autos-run",
				children: [/* @__PURE__ */ u("summary", { children: [
					/* @__PURE__ */ u("span", {
						class: `autos-st s-${r.status}`,
						children: r.status === "ok" ? "✓" : r.status === "skipped" ? "↷" : "✕"
					}),
					/* @__PURE__ */ u("span", {
						class: "autos-when",
						children: when(r.at)
					}),
					/* @__PURE__ */ u("b", { children: r.name }),
					/* @__PURE__ */ u("span", {
						class: "autos-dim",
						children: r.status === "skipped" ? `skipped: ${r.text}` : r.trigger
					})
				] }), (r.steps || []).map((s, j) => /* @__PURE__ */ u("div", {
					class: `autos-step-run${s.ok ? "" : " bad"}`,
					children: [
						s.halt ? "⏹" : s.ok ? "✓" : "✕",
						" ",
						s.what,
						s.text ? /* @__PURE__ */ u("small", { children: [" — ", s.text] }) : null
					]
				}, j))]
			}, i))]
		}) : null
	] });
}
function Item({ a, onEdit, onSave, onDelete, onRun }) {
	const [sure, setSure] = d(false);
	const status = a.running ? "running now…" : a.nextRun ? `next ${when(a.nextRun)}` : a.enabled && a.trigger.type === "event" ? "waiting for the event" : a.enabled ? "" : "off";
	return /* @__PURE__ */ u("article", {
		class: `autos-item${a.enabled ? "" : " off"}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "autos-head",
				children: [/* @__PURE__ */ u("button", {
					class: `autos-sw${a.enabled ? " on" : ""}`,
					role: "switch",
					"aria-checked": a.enabled,
					"aria-label": `${a.enabled ? "switch off" : "switch on"} ${a.name}`,
					onClick: () => onSave({
						...a,
						enabled: !a.enabled
					}, !a.enabled && needsPasskey(a)),
					children: a.enabled ? "● on" : "○ off"
				}), /* @__PURE__ */ u("b", {
					class: "autos-name",
					children: a.name
				})]
			}),
			/* @__PURE__ */ u("div", {
				class: "autos-flow",
				children: [/* @__PURE__ */ u("span", {
					class: "autos-trigger",
					children: describeTrigger(a.trigger)
				}), a.steps.map((s, i) => /* @__PURE__ */ u("span", {
					class: "autos-chip",
					children: ["→ ", describeStep(s)]
				}, i))]
			}),
			/* @__PURE__ */ u("div", {
				class: "autos-foot",
				children: [
					/* @__PURE__ */ u("span", {
						class: "autos-dim",
						children: [status, a.lastRun ? ` · last ${when(a.lastRun.at)} ${a.lastRun.ok ? "✓" : "✕"}` : ""]
					}),
					/* @__PURE__ */ u("span", { class: "autos-grow" }),
					/* @__PURE__ */ u(Btn, {
						label: "run now",
						onClick: () => onRun(a.id)
					}),
					/* @__PURE__ */ u(Btn, {
						label: "edit",
						onClick: () => onEdit(a.id)
					}),
					sure ? /* @__PURE__ */ u(Btn, {
						label: "delete it",
						cls: "danger",
						onClick: () => onDelete(a.id)
					}) : /* @__PURE__ */ u(Btn, {
						label: "delete",
						onClick: () => setSure(true)
					})
				]
			})
		]
	});
}
function Editor({ data, editing, onSave, onDraft, onCancel }) {
	const existing = editing !== "new" ? (data.automations || []).find((a) => a.id === editing) : null;
	const [draft, setDraft] = d(() => existing ? clone(existing) : blankAutomation());
	const [tab, setTab] = d("steps");
	const [busy, setBusy] = d(false);
	if (editing !== "new" && !existing) return /* @__PURE__ */ u("p", {
		class: "autos-dim",
		children: "that automation is not there any more."
	});
	const fleet = data.fleet || [];
	const set = (patch) => setDraft((d) => ({
		...d,
		...patch
	}));
	const setTrigger = (patch) => setDraft((d) => ({
		...d,
		trigger: {
			...d.trigger,
			...patch
		}
	}));
	const setStep = (i, patch) => setDraft((d) => ({
		...d,
		steps: d.steps.map((s, j) => j === i ? {
			...s,
			...patch
		} : s)
	}));
	const move = (i, to) => setDraft((d) => {
		const steps = [...d.steps];
		const [s] = steps.splice(i, 1);
		steps.splice(to, 0, s);
		return {
			...d,
			steps
		};
	});
	const key = needsPasskey(draft) && draft.enabled;
	const save = async () => {
		setBusy(true);
		try {
			await onSave(draft, key);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u("label", {
			class: "autos-field",
			children: [/* @__PURE__ */ u("span", { children: "name" }), /* @__PURE__ */ u("input", {
				type: "text",
				value: draft.name,
				placeholder: "morning review",
				onInput: (e) => set({ name: e.currentTarget.value })
			})]
		}),
		/* @__PURE__ */ u("div", {
			class: "seg autos-tabs",
			children: [/* @__PURE__ */ u(Btn, {
				label: "steps",
				cls: tab === "steps" ? "on" : "",
				onClick: () => setTab("steps")
			}), /* @__PURE__ */ u(Btn, {
				label: "ask for it",
				cls: tab === "ask" ? "on" : "",
				onClick: () => setTab("ask")
			})]
		}),
		tab === "ask" ? /* @__PURE__ */ u(Ask, {
			draft,
			onDraft,
			onApply: (a) => {
				setDraft((d) => ({
					...d,
					...a,
					id: d.id,
					enabled: d.enabled
				}));
				setTab("steps");
			}
		}) : /* @__PURE__ */ u(S, { children: [
			/* @__PURE__ */ u(Trigger, {
				t: draft.trigger,
				fleet,
				onChange: setTrigger,
				onType: (type) => set({ trigger: blankTrigger(type) })
			}),
			draft.steps.map((s, i) => /* @__PURE__ */ u(Step, {
				s,
				i,
				n: draft.steps.length,
				isEvent: draft.trigger.type === "event",
				fleet,
				onChange: (patch) => setStep(i, patch),
				onMove: (to) => move(i, to),
				onRemove: () => setDraft((d) => ({
					...d,
					steps: d.steps.filter((_, j) => j !== i)
				}))
			}, i)),
			/* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "add a step" }), /* @__PURE__ */ u("select", {
					value: "",
					onChange: (e) => {
						const v = e.currentTarget.value;
						if (v) setDraft((d) => ({
							...d,
							steps: [...d.steps, blankStep(v)]
						}));
						e.currentTarget.value = "";
					},
					children: [/* @__PURE__ */ u("option", {
						value: "",
						children: "choose…"
					}), Object.entries(ACTIONS).map(([k, d]) => /* @__PURE__ */ u("option", {
						value: k,
						children: d.label
					}, k))]
				})]
			})
		] }),
		/* @__PURE__ */ u("label", {
			class: "autos-check",
			children: [/* @__PURE__ */ u("input", {
				type: "checkbox",
				checked: draft.enabled,
				onChange: (e) => set({ enabled: e.currentTarget.checked })
			}), " switched on"]
		}),
		key ? /* @__PURE__ */ u("p", {
			class: "autos-note",
			children: "It can start or stop sessions on its own, so saving it asks for your passkey — the same one a tap on start or stop would."
		}) : null,
		/* @__PURE__ */ u("div", {
			class: "row autos-save",
			children: [/* @__PURE__ */ u(Btn, {
				label: "cancel",
				onClick: onCancel
			}), /* @__PURE__ */ u(Btn, {
				label: busy ? "saving…" : "save",
				cls: "go",
				onClick: busy ? void 0 : save
			})]
		})
	] });
}
function Seg({ value, options, onChange }) {
	return /* @__PURE__ */ u("div", {
		class: "seg",
		children: options.map(([v, label]) => /* @__PURE__ */ u(Btn, {
			label,
			cls: value === v ? "on" : "",
			onClick: () => value !== v && onChange(v)
		}, v))
	});
}
function Trigger({ t, fleet, onChange, onType }) {
	const sessions = fleet.find((p) => p.name === t.project)?.sessions || [];
	return /* @__PURE__ */ u("section", {
		class: "autos-block",
		children: [
			/* @__PURE__ */ u("h3", { children: "when" }),
			/* @__PURE__ */ u(Seg, {
				value: t.type,
				options: [["schedule", "scheduled"], ["event", "when a session changes"]],
				onChange: onType
			}),
			t.type === "schedule" ? /* @__PURE__ */ u(S, { children: [
				/* @__PURE__ */ u(Seg, {
					value: t.mode,
					options: [
						["days", "weekly"],
						["once", "once"],
						["every", "every…"]
					],
					onChange: (mode) => onChange({ mode })
				}),
				t.mode === "days" ? /* @__PURE__ */ u("div", {
					class: "seg autos-days",
					role: "group",
					"aria-label": "days",
					children: [
						1,
						2,
						3,
						4,
						5,
						6,
						0
					].map((d) => /* @__PURE__ */ u(Btn, {
						label: DAY_NAMES[d],
						cls: t.days.includes(d) ? "on" : "",
						onClick: () => onChange({ days: t.days.includes(d) ? t.days.filter((x) => x !== d) : [...t.days, d] })
					}, d))
				}) : null,
				t.mode === "once" ? /* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "date" }), /* @__PURE__ */ u("input", {
						type: "date",
						value: t.date,
						onInput: (e) => onChange({ date: e.currentTarget.value })
					})]
				}) : null,
				t.mode !== "every" ? /* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "time" }), /* @__PURE__ */ u("input", {
						type: "time",
						value: t.at,
						onInput: (e) => onChange({ at: e.currentTarget.value })
					})]
				}) : /* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "every" }), /* @__PURE__ */ u("select", {
						value: t.minutes,
						onChange: (e) => onChange({ minutes: Number(e.currentTarget.value) }),
						children: EVERY.map((m) => /* @__PURE__ */ u("option", {
							value: m,
							children: everyWords(m)
						}, m))
					})]
				})
			] }) : /* @__PURE__ */ u(S, { children: [
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "when a session…" }), /* @__PURE__ */ u("select", {
						value: t.event,
						onChange: (e) => onChange({ event: e.currentTarget.value }),
						children: Object.entries(EVENTS).map(([k, d]) => /* @__PURE__ */ u("option", {
							value: k,
							children: [
								d.label,
								" (",
								d.hint,
								")"
							]
						}, k))
					})]
				}),
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "in project" }), /* @__PURE__ */ u("select", {
						value: t.project,
						onChange: (e) => onChange({
							project: e.currentTarget.value,
							session: "*"
						}),
						children: [/* @__PURE__ */ u("option", {
							value: "*",
							children: "any project"
						}), fleet.map((p) => /* @__PURE__ */ u("option", {
							value: p.name,
							children: p.name
						}, p.name))]
					})]
				}),
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "session" }), /* @__PURE__ */ u("select", {
						value: t.session,
						disabled: t.project === "*",
						onChange: (e) => onChange({ session: e.currentTarget.value }),
						children: [/* @__PURE__ */ u("option", {
							value: "*",
							children: "any session"
						}), sessions.map((s) => /* @__PURE__ */ u("option", {
							value: s.name,
							children: s.lead ? `${s.name} (lead)` : s.name
						}, s.name))]
					})]
				}),
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "not again for the same session within (min)" }), /* @__PURE__ */ u("input", {
						type: "number",
						min: "1",
						max: "1440",
						value: t.cooldown,
						onInput: (e) => onChange({ cooldown: Number(e.currentTarget.value) })
					})]
				})
			] }),
			/* @__PURE__ */ u("p", {
				class: "autos-say",
				children: describeTrigger(t)
			})
		]
	});
}
function Step({ s, i, n, isEvent, fleet, onChange, onMove, onRemove }) {
	const d = ACTIONS[s.action];
	const has = (f) => d.needs.includes(f) || (d.optional || []).includes(f);
	const fromEvent = s.project === EVENT_PROJECT;
	const sessions = fleet.find((p) => p.name === s.project)?.sessions || [];
	return /* @__PURE__ */ u("section", {
		class: `autos-block${d.passkey ? " key" : ""}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "autos-head",
				children: [
					/* @__PURE__ */ u("h3", { children: [
						i + 1,
						". ",
						d.label
					] }),
					/* @__PURE__ */ u("span", { class: "autos-grow" }),
					/* @__PURE__ */ u(Btn, {
						label: "↑",
						onClick: i ? () => onMove(i - 1) : void 0,
						cls: i ? "" : "off"
					}),
					/* @__PURE__ */ u(Btn, {
						label: "↓",
						onClick: i < n - 1 ? () => onMove(i + 1) : void 0,
						cls: i < n - 1 ? "" : "off"
					}),
					/* @__PURE__ */ u(Btn, {
						label: "✕",
						onClick: onRemove
					})
				]
			}),
			has("project") ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "project" }), /* @__PURE__ */ u("select", {
					value: s.project,
					onChange: (e) => {
						const v = e.currentTarget.value;
						onChange(v === "{project}" ? {
							project: v,
							session: EVENT_SESSION
						} : {
							project: v,
							session: ""
						});
					},
					children: [
						/* @__PURE__ */ u("option", {
							value: "",
							children: "choose…"
						}),
						isEvent ? /* @__PURE__ */ u("option", {
							value: EVENT_PROJECT,
							children: "the event's project"
						}) : null,
						fleet.map((p) => /* @__PURE__ */ u("option", {
							value: p.name,
							children: p.name
						}, p.name))
					]
				})]
			}) : null,
			has("session") ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "session" }), /* @__PURE__ */ u("select", {
					value: s.session,
					disabled: !s.project,
					onChange: (e) => onChange({ session: e.currentTarget.value }),
					children: [
						/* @__PURE__ */ u("option", {
							value: "",
							children: "choose…"
						}),
						isEvent ? /* @__PURE__ */ u("option", {
							value: EVENT_SESSION,
							children: "the event's session"
						}) : null,
						!fromEvent ? sessions.map((x) => /* @__PURE__ */ u("option", {
							value: x.name,
							children: x.lead ? `${x.name} (lead)` : x.name
						}, x.name)) : null
					]
				})]
			}) : null,
			has("name") ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "new session's name" }), /* @__PURE__ */ u("input", {
					type: "text",
					value: s.name,
					placeholder: "review-{date}",
					onInput: (e) => onChange({ name: e.currentTarget.value })
				})]
			}) : null,
			has("prompt") ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: s.action === "send" ? "message" : s.action === "spawn" ? "first task (optional)" : "message on resume (optional)" }), /* @__PURE__ */ u("textarea", {
					rows: 3,
					value: s.prompt,
					placeholder: "{date} {time} {project} {session} are filled in",
					onInput: (e) => onChange({ prompt: e.currentTarget.value })
				})]
			}) : null,
			has("branch") ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "branch (optional)" }), /* @__PURE__ */ u("input", {
					type: "text",
					value: s.branch,
					onInput: (e) => onChange({ branch: e.currentTarget.value })
				})]
			}) : null,
			s.action === "notify" ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "text" }), /* @__PURE__ */ u("input", {
					type: "text",
					value: s.text,
					placeholder: "{session} finished in {project}",
					onInput: (e) => onChange({ text: e.currentTarget.value })
				})]
			}) : null,
			s.action === "check" ? /* @__PURE__ */ u("div", {
				class: "autos-field",
				children: [
					/* @__PURE__ */ u("span", { children: "…if it is now" }),
					/* @__PURE__ */ u("div", {
						class: "seg autos-days",
						role: "group",
						"aria-label": "statuses",
						children: STATES.map((k) => /* @__PURE__ */ u(Btn, {
							label: k,
							cls: s.status.includes(k) ? "on" : "",
							onClick: () => onChange({ status: s.status.includes(k) ? s.status.filter((x) => x !== k) : [...s.status, k] })
						}, k))
					}),
					/* @__PURE__ */ u("small", {
						class: "autos-dim",
						children: "If it is not, the run ends here — not an error."
					})
				]
			}) : null,
			s.action === "wait" ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "minutes (1–60)" }), /* @__PURE__ */ u("input", {
					type: "number",
					min: "1",
					max: "60",
					value: s.minutes,
					onInput: (e) => onChange({ minutes: Number(e.currentTarget.value) })
				})]
			}) : null
		]
	});
}
function Ask({ draft, onDraft, onApply }) {
	const [msgs, setMsgs] = d([]);
	const [text, setText] = d("");
	const [busy, setBusy] = d(false);
	const end = A(null);
	h(() => {
		try {
			end.current?.scrollIntoView({ block: "end" });
		} catch {}
	}, [msgs, busy]);
	const ask = async () => {
		const t = text.trim();
		if (!t || busy) return;
		const next = [...msgs, {
			role: "user",
			text: t
		}];
		setMsgs(next);
		setText("");
		setBusy(true);
		try {
			const r = await onDraft(next, draft.steps.length || draft.name ? {
				name: draft.name,
				trigger: draft.trigger,
				steps: draft.steps
			} : null);
			setMsgs((m) => [...m, {
				role: "ai",
				text: r.reply,
				automation: r.automation || null
			}]);
		} catch (e) {
			setMsgs((m) => [...m, {
				role: "ai",
				text: `could not: ${e.message}`,
				error: true
			}]);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u("section", {
		class: "autos-ask",
		children: [
			!msgs.length ? /* @__PURE__ */ u("p", {
				class: "autos-dim",
				children: "Say it in a sentence — \"every weekday at 09:00, wake the workers in acme-api and tell the lead to share out what is open\". It fills in the steps; you check them and save."
			}) : null,
			msgs.map((m, i) => /* @__PURE__ */ u("div", {
				class: `autos-msg ${m.role}${m.error ? " bad" : ""}`,
				children: [m.text, m.automation ? /* @__PURE__ */ u("div", { children: /* @__PURE__ */ u(Btn, {
					label: "put it in the editor",
					cls: "go",
					onClick: () => onApply(m.automation)
				}) }) : null]
			}, i)),
			busy ? /* @__PURE__ */ u("div", {
				class: "autos-msg ai autos-dim",
				children: "writing it…"
			}) : null,
			/* @__PURE__ */ u("div", { ref: end }),
			/* @__PURE__ */ u("textarea", {
				rows: 2,
				value: text,
				placeholder: "what should happen, and when?",
				onInput: (e) => setText(e.currentTarget.value)
			}),
			/* @__PURE__ */ u("div", {
				class: "row",
				children: /* @__PURE__ */ u(Btn, {
					label: "ask",
					cls: "go",
					onClick: busy || !text.trim() ? void 0 : ask
				})
			})
		]
	});
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
	review: ReviewScreen,
	automations: AutomationsScreen
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
export { Btn, CardScreen, Header, mount, unmount };
