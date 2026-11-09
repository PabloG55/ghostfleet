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
function Bar$1({ run, t, v, gate, save, onFlow, onRestOk, onRetry }) {
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
		/* @__PURE__ */ u(Bar$1, {
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
var LIMITS = {
	steps: 20,
	prompt: 4e3,
	name: 80,
	text: 300,
	waitMin: 60,
	cooldownMin: 1440,
	everyMin: 15
};
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
var SESSION_OK = /^[A-Za-z0-9][A-Za-z0-9 ._~-]{0,47}$/;
var TEMPLATE_OK = /^[A-Za-z0-9{}][A-Za-z0-9 ._~{}-]{0,79}$/;
var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var str = (v, max) => String(v ?? "").trim().slice(0, max);
var bad = (text) => Object.assign(new Error(text), { status: 400 });
var own = (o, k) => typeof k === "string" && Object.hasOwn(o, k);
var realDate = (v) => {
	if (typeof v !== "string" || !DATE.test(v)) return false;
	const [y, m, d] = v.split("-").map(Number), x = new Date(y, m - 1, d);
	return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d;
};
var dayOf = (d) => typeof d === "number" || typeof d === "string" && d.trim() !== "" ? Number(d) : NaN;
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
var needsPasskey = (a) => (a?.steps || []).some((s) => own(ACTIONS, s.action) && ACTIONS[s.action].passkey);
function normalize(raw, { strict = true } = {}) {
	const a = raw && typeof raw === "object" ? raw : {};
	const name = str(a.name, LIMITS.name) || "untitled automation";
	const t = a.trigger && typeof a.trigger === "object" ? a.trigger : {};
	let trigger;
	if (t.type === "event") {
		if (!own(EVENTS, t.event)) throw bad(`unknown event: ${t.event}`);
		const project = str(t.project, 80) || "*", session = str(t.session, 48) || "*";
		if (session !== "*" && !SESSION_OK.test(session)) throw bad(`the trigger names an invalid session: '${session}'`);
		const cooldown = Math.max(1, Math.min(LIMITS.cooldownMin, Math.round(Number(t.cooldown) || 10)));
		trigger = {
			type: "event",
			event: t.event,
			project,
			session,
			cooldown
		};
	} else {
		const mode = [
			"once",
			"days",
			"every"
		].includes(t.mode) ? t.mode : "days";
		const at = typeof t.at === "string" && HHMM.test(t.at) ? t.at : "10:00";
		const days = [...new Set((Array.isArray(t.days) ? t.days : []).map(dayOf).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
		const date = realDate(t.date) ? t.date : "";
		const minutes = Math.max(LIMITS.everyMin, Math.min(10080, Math.round(Number(t.minutes) || 60)));
		if (strict && mode === "once" && !date) throw bad("a one-off run needs a real date");
		if (strict && mode === "days" && !days.length) throw bad("pick at least one day of the week");
		trigger = {
			type: "schedule",
			mode,
			at,
			days,
			date,
			minutes
		};
		if (strict && mode === "once" && nextAfter(trigger, Math.floor(Date.now() / 1e3)) == null) throw bad(`${date} at ${at} has already passed: pick a later time`);
	}
	const list = Array.isArray(a.steps) ? a.steps : [];
	if (list.length > LIMITS.steps) throw bad(`at most ${LIMITS.steps} steps`);
	const steps = list.map((s, i) => {
		const action = s?.action;
		if (!own(ACTIONS, action)) throw bad(`step ${i + 1}: unknown action '${action}'`);
		const def = ACTIONS[action];
		const o = { action };
		if (def.needs.includes("project")) o.project = str(s.project, 80);
		if (def.needs.includes("session")) {
			o.session = str(s.session, 48);
			if (o.session && o.session !== "{session}" && !SESSION_OK.test(o.session)) throw bad(`step ${i + 1}: invalid session name '${o.session}'`);
		}
		if (def.needs.includes("prompt") || def.optional?.includes("prompt")) o.prompt = str(s.prompt, LIMITS.prompt);
		if (def.needs.includes("name")) {
			o.name = str(s.name, 80);
			if (o.name && !TEMPLATE_OK.test(o.name)) throw bad(`step ${i + 1}: a session name takes letters, digits, spaces and . _ ~ -`);
		}
		if (def.optional?.includes("branch")) o.branch = str(s.branch, 80);
		if (action === "wait") o.minutes = Math.max(1, Math.min(LIMITS.waitMin, Math.round(Number(s.minutes) || 1)));
		if (action === "notify") o.text = str(s.text, LIMITS.text);
		if (action === "check") o.status = [...new Set((Array.isArray(s.status) ? s.status : []).filter((x) => STATES.includes(x)))];
		if (strict) {
			for (const f of def.needs) if (o[f] === "" || o[f] == null || Array.isArray(o[f]) && !o[f].length) throw bad(`step ${i + 1} (${def.label}): ${FIELD[f] || f} is missing`);
			if ((o.project === "{project}" || o.session === "{session}") && trigger.type !== "event") throw bad(`step ${i + 1}: "the event's session" only exists when the trigger is an event`);
		}
		return o;
	});
	if (strict && !steps.length) throw bad("add at least one step");
	return {
		id: str(a.id, 40) || null,
		name,
		enabled: a.enabled !== false,
		trigger,
		steps
	};
}
var FIELD = {
	status: "at least one status",
	project: "the project",
	session: "the session",
	prompt: "the message",
	name: "the name",
	text: "the text",
	minutes: "the minutes"
};
var localAt = (y, m, d, hhmm) => {
	const [h, mi] = hhmm.split(":").map(Number);
	return Math.floor(new Date(y, m, d, h, mi, 0).getTime() / 1e3);
};
function nextAfter(trigger, t, anchor = t) {
	if (!trigger || trigger.type !== "schedule") return null;
	if (trigger.mode === "once") {
		if (!trigger.date) return null;
		const [y, m, d] = trigger.date.split("-").map(Number);
		const at = localAt(y, m - 1, d, trigger.at);
		return at > t ? at : null;
	}
	if (trigger.mode === "every") {
		const step = trigger.minutes * 60;
		const k = Math.floor((t - anchor) / step) + 1;
		return anchor + Math.max(1, k) * step;
	}
	const base = /* @__PURE__ */ new Date(t * 1e3);
	for (let i = 0; i <= 7; i++) {
		const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
		if (!trigger.days.includes(d.getDay())) continue;
		const at = localAt(d.getFullYear(), d.getMonth(), d.getDate(), trigger.at);
		if (at > t) return at;
	}
	return null;
}
var everyWords = (m) => m % 1440 === 0 ? `${m / 1440} day${m > 1440 ? "s" : ""}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`;
function daysWords(days) {
	const s = [...days].sort().join(",");
	if (s === "0,1,2,3,4,5,6") return "every day";
	if (s === "1,2,3,4,5") return "weekdays";
	if (s === "0,6") return "weekends";
	return days.map((d) => DAY_NAMES[d]).join(", ");
}
function dateWords(date) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
	if (!m) return date || "?";
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return d.toLocaleDateString(void 0, {
		month: "short",
		day: "numeric",
		...d.getFullYear() !== (/* @__PURE__ */ new Date()).getFullYear() ? { year: "numeric" } : {}
	});
}
function describeTrigger(t) {
	if (!t) return "";
	if (t.type === "event") return `when ${t.session && t.session !== "*" ? t.session : "any session"} ${!t.project || t.project === "*" ? "in any project" : `in ${t.project}`} ${own(EVENTS, t.event) ? EVENTS[t.event].label : t.event}`;
	if (t.mode === "once") return `once, ${dateWords(t.date)} at ${t.at}`;
	if (t.mode === "every") return `every ${everyWords(t.minutes)}`;
	return `${daysWords(t.days)} at ${t.at}`;
}
var where = (s) => `${s.session === "{session}" ? "the event's session" : s.session || "?"}${s.project && s.project !== "{project}" ? ` (${s.project})` : ""}`;
var clip = (v, n) => {
	const x = String(v || "");
	return x.length > n ? `${x.slice(0, n)}…` : x;
};
function describeStep(s) {
	if (!own(ACTIONS, s?.action)) return String(s?.action ?? "");
	const d = ACTIONS[s.action];
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
var when = (ts) => (/* @__PURE__ */ new Date(ts * 1e3)).toLocaleString(void 0, Math.abs(ts - Date.now() / 1e3) > 518400 ? {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit"
} : {
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit"
});
var clone = (v) => JSON.parse(JSON.stringify(v));
var eventOnly = (a) => a.trigger.type === "event" && a.steps.some((s) => s.project === "{project}" || s.session === "{session}");
function AutomationsScreen(p) {
	return /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u(Header, {
			scope: p.editing ? p.editing === "new" ? "— new automation" : "— edit automation" : "— automations",
			mode: p.mode,
			stale: p.stale,
			onBack: p.onBack
		}),
		p.data == null ? p.error ? /* @__PURE__ */ u(Failed, {
			error: p.error,
			onRetry: p.onRetry
		}) : /* @__PURE__ */ u(Loading, {}) : p.editing ? /* @__PURE__ */ u(Editor, { ...p }, p.editing) : /* @__PURE__ */ u(List, { ...p }),
		p.toast ? /* @__PURE__ */ u("div", {
			class: ("toast " + (p.toast.kind || "")).trim(),
			children: p.toast.text
		}) : null
	] });
}
var Bar = ({ children }) => /* @__PURE__ */ u("div", {
	class: "autos-bar",
	children
});
function Loading() {
	return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
		class: "cards autos",
		"aria-busy": "true",
		"aria-label": "reading the automations",
		children: [
			0,
			1,
			2
		].map((i) => /* @__PURE__ */ u("div", {
			class: "card skel",
			children: [
				/* @__PURE__ */ u("div", { class: "skel-bar w1" }),
				/* @__PURE__ */ u("div", { class: "skel-bar w2" }),
				/* @__PURE__ */ u("div", { class: "skel-bar w3" })
			]
		}, i))
	}), /* @__PURE__ */ u(Bar, { children: /* @__PURE__ */ u("div", {
		class: "autos-acts",
		children: /* @__PURE__ */ u("button", {
			type: "button",
			class: "go",
			disabled: true,
			children: "new automation"
		})
	}) })] });
}
function Failed({ error, onRetry }) {
	return /* @__PURE__ */ u("div", {
		class: "cards autos",
		children: /* @__PURE__ */ u("div", {
			class: "autos-empty",
			role: "alert",
			children: [
				/* @__PURE__ */ u("h3", { children: "could not read the automations" }),
				/* @__PURE__ */ u("p", { children: error }),
				/* @__PURE__ */ u("button", {
					type: "button",
					class: "go",
					onClick: onRetry,
					children: "try again"
				})
			]
		})
	});
}
function List({ data, onEdit, onSave, onSeen, onSay }) {
	const list = data.automations || [];
	const unseen = (data.notices || []).filter((n) => !n.seen);
	const runs = data.runs || [];
	return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
		class: "cards autos",
		children: [
			unseen.length ? /* @__PURE__ */ u(Notices, {
				list: unseen,
				onSeen
			}) : null,
			!list.length ? /* @__PURE__ */ u("div", {
				class: "autos-empty",
				children: [/* @__PURE__ */ u("h3", { children: "no automations yet" }), /* @__PURE__ */ u("p", { children: "One is a trigger and some steps. For example: \"weekdays at 09:00, send the lead of acme-api: review what is open\", or \"when any session in acme-web needs you, tell me\"." })]
			}) : null,
			list.map((a) => /* @__PURE__ */ u(Item, {
				a,
				onEdit,
				onSave,
				onSay
			}, a.id)),
			runs.length ? /* @__PURE__ */ u("section", {
				class: "autos-block autos-wide",
				children: [/* @__PURE__ */ u("h3", { children: "last runs" }), /* @__PURE__ */ u(Capped, {
					items: runs,
					n: 10,
					render: (r, i) => /* @__PURE__ */ u(Run, { r }, i)
				})]
			}) : null
		]
	}), /* @__PURE__ */ u(Bar, { children: /* @__PURE__ */ u("div", {
		class: "autos-acts",
		children: /* @__PURE__ */ u("button", {
			type: "button",
			class: "go",
			onClick: () => onEdit("new"),
			children: "new automation"
		})
	}) })] });
}
function Capped({ items, n, render }) {
	const [all, setAll] = d(false);
	const shown = all ? items : items.slice(0, n);
	return /* @__PURE__ */ u(S, { children: [shown.map(render), items.length > shown.length ? /* @__PURE__ */ u("button", {
		type: "button",
		onClick: () => setAll(true),
		children: [
			"show ",
			items.length - shown.length,
			" more"
		]
	}) : null] });
}
function Notices({ list, onSeen }) {
	return /* @__PURE__ */ u("section", {
		class: "autos-block autos-wide",
		"aria-label": "needs a look",
		children: [/* @__PURE__ */ u("div", {
			class: "autos-head",
			children: [/* @__PURE__ */ u("h3", { children: "needs a look" }), /* @__PURE__ */ u("button", {
				type: "button",
				onClick: onSeen,
				children: "mark as seen"
			})]
		}), /* @__PURE__ */ u(Capped, {
			items: list,
			n: 3,
			render: (n) => /* @__PURE__ */ u("div", {
				class: `autos-notice k-${n.kind}`,
				children: [
					/* @__PURE__ */ u("span", {
						class: "autos-when",
						children: when(n.at)
					}),
					" ",
					n.text
				]
			}, n.id)
		})]
	});
}
var RUN_WORD = {
	ok: "✓ ran",
	error: "✕ failed",
	skipped: "– skipped",
	stopped: "■ stopped"
};
function Run({ r }) {
	const steps = r.steps || [];
	const head = /* @__PURE__ */ u(S, { children: [
		/* @__PURE__ */ u("span", {
			class: `autos-st s-${r.status}`,
			children: RUN_WORD[r.status] || r.status
		}),
		/* @__PURE__ */ u("b", {
			class: "autos-run-name",
			children: r.name
		}),
		/* @__PURE__ */ u("span", {
			class: "autos-when",
			children: when(r.at)
		}),
		/* @__PURE__ */ u("span", {
			class: "autos-run-why",
			children: r.status === "skipped" || r.status === "stopped" ? r.text : r.trigger
		})
	] });
	if (!steps.length) return /* @__PURE__ */ u("div", {
		class: "autos-run",
		children: /* @__PURE__ */ u("div", {
			class: "autos-run-head",
			children: head
		})
	});
	return /* @__PURE__ */ u("details", {
		class: "autos-run",
		children: [/* @__PURE__ */ u("summary", {
			class: "autos-run-head",
			children: head
		}), steps.map((s, j) => /* @__PURE__ */ u("div", {
			class: `autos-step-run${s.ok ? "" : " bad"}`,
			children: [
				s.halt ? "■" : s.ok ? "✓" : "✕",
				" ",
				s.what,
				s.text ? /* @__PURE__ */ u("small", { children: [" — ", s.text] }) : null
			]
		}, j))]
	});
}
function Switch({ on, label, busy, onClick }) {
	return /* @__PURE__ */ u("button", {
		type: "button",
		class: `autos-sw${on ? " on" : ""}`,
		role: "switch",
		"aria-checked": on ? "true" : "false",
		"aria-label": label,
		"aria-busy": busy ? "true" : null,
		onClick,
		children: /* @__PURE__ */ u("span", {
			class: "autos-knob",
			"aria-hidden": "true"
		})
	});
}
function Item({ a, onEdit, onSave, onSay }) {
	const [want, setWant] = d(null);
	const on = want == null ? a.enabled : want;
	const toggle = async () => {
		if (want != null) return;
		setWant(!a.enabled);
		const r = await onSave({
			...a,
			enabled: !a.enabled
		}, !a.enabled && needsPasskey(a));
		setWant(null);
		if (r && r.error) onSay(r.error);
	};
	const failed = a.lastRun && !a.lastRun.ok;
	const hue = a.running ? "var(--cyan)" : !on ? "var(--dim)" : failed ? "var(--red)" : "var(--green)";
	const status = a.running ? "running now" : !on ? "off" : a.nextRun ? `next ${when(a.nextRun)}` : a.trigger.type === "event" ? "waiting for the event" : "";
	const more = a.steps.length - 3;
	return /* @__PURE__ */ u("article", {
		class: `card autos-card${on ? "" : " off"}`,
		style: `--c: ${hue}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "c-top",
				children: [/* @__PURE__ */ u("button", {
					type: "button",
					class: "c-name autos-open",
					onClick: () => onEdit(a.id),
					children: a.name
				}), /* @__PURE__ */ u(Switch, {
					on,
					label: a.name,
					busy: want != null,
					onClick: toggle
				})]
			}),
			/* @__PURE__ */ u("p", {
				class: "autos-say",
				children: describeTrigger(a.trigger)
			}),
			/* @__PURE__ */ u("ol", {
				class: "autos-steps",
				children: [a.steps.slice(0, 3).map((s, i) => /* @__PURE__ */ u("li", { children: describeStep(s) }, i)), more > 0 ? /* @__PURE__ */ u("li", {
					class: "autos-dim",
					children: [
						"and ",
						more,
						" more"
					]
				}) : null]
			}),
			/* @__PURE__ */ u("div", {
				class: "autos-status",
				children: [status ? /* @__PURE__ */ u("span", { children: status }) : null, a.lastRun ? /* @__PURE__ */ u("span", {
					class: failed ? "bad" : "",
					children: [
						failed ? "failed" : "last ran",
						" ",
						when(a.lastRun.at)
					]
				}) : null]
			})
		]
	});
}
function Editor({ data, editing, onSave, onDelete, onRun, onDraft, onCancel }) {
	const existing = editing !== "new" ? (data.automations || []).find((a) => a.id === editing) : null;
	const [draft, setDraft] = d(() => existing ? clone(existing) : blankAutomation());
	const [opened] = d(() => JSON.stringify(draft));
	const [tab, setTab] = d("steps");
	const [busy, setBusy] = d(false);
	const [err, setErr] = d("");
	const [chat, setChat] = d({
		msgs: [],
		text: ""
	});
	const [menu, setMenu] = d(null);
	const refocus = A(null);
	h(() => {
		const tries = refocus.current;
		if (!tries) return;
		refocus.current = null;
		for (const q of tries) {
			const el = document.querySelector(q);
			if (el && !el.disabled) {
				el.focus();
				return;
			}
		}
	});
	if (editing !== "new" && !existing) return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
		class: "cards autos",
		children: /* @__PURE__ */ u("div", {
			class: "autos-empty",
			children: /* @__PURE__ */ u("h3", { children: "that automation is not there any more" })
		})
	}), /* @__PURE__ */ u(Bar, { children: /* @__PURE__ */ u("div", {
		class: "autos-acts",
		children: /* @__PURE__ */ u("button", {
			type: "button",
			onClick: onCancel,
			children: "back to the list"
		})
	}) })] });
	const fleet = data.fleet || [];
	const edit = (fn) => {
		setErr("");
		setDraft(fn);
	};
	const set = (patch) => edit((d) => ({
		...d,
		...patch
	}));
	const setTrigger = (patch) => edit((d) => ({
		...d,
		trigger: {
			...d.trigger,
			...patch
		}
	}));
	const setStep = (i, patch) => edit((d) => ({
		...d,
		steps: d.steps.map((s, j) => j === i ? {
			...s,
			...patch
		} : s)
	}));
	const move = (i, to) => {
		const dir = to < i ? "up" : "down";
		refocus.current = [`[data-move="${to}:${dir}"]`, `[data-move="${to}:${dir === "up" ? "down" : "up"}"]`];
		setMenu(to);
		edit((d) => {
			const steps = [...d.steps];
			const [s] = steps.splice(i, 1);
			steps.splice(to, 0, s);
			return {
				...d,
				steps
			};
		});
	};
	const remove = (i) => {
		setMenu(null);
		refocus.current = [".autos-add select"];
		edit((d) => ({
			...d,
			steps: d.steps.filter((_, j) => j !== i)
		}));
	};
	const key = needsPasskey(draft) && draft.enabled;
	const save = async () => {
		if (busy) return;
		if (key) try {
			normalize(draft);
		} catch (e) {
			setErr(e.message);
			return;
		}
		setBusy(true);
		setErr("");
		const r = await onSave(draft, key);
		setBusy(false);
		if (r && r.error) setErr(r.error);
	};
	return /* @__PURE__ */ u(S, { children: [/* @__PURE__ */ u("div", {
		class: "cards autos autos-form",
		children: /* @__PURE__ */ u("div", {
			class: "autos-col",
			children: [
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "name" }), /* @__PURE__ */ u("input", {
						type: "text",
						value: draft.name,
						placeholder: "morning review",
						autocomplete: "off",
						onInput: (e) => set({ name: e.currentTarget.value })
					})]
				}),
				/* @__PURE__ */ u(Seg, {
					label: "how to build it",
					cls: "tabs",
					value: tab,
					options: [["steps", "steps"], ["ask", "ask for it"]],
					onChange: setTab
				}),
				tab === "ask" ? /* @__PURE__ */ u(Ask, {
					draft,
					chat,
					setChat,
					onDraft,
					onApply: (a) => {
						edit((d) => ({
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
						open: menu === i,
						onMenu: () => setMenu(menu === i ? null : i),
						onChange: (patch) => setStep(i, patch),
						onMove: (to) => move(i, to),
						onRemove: () => remove(i)
					}, i)),
					/* @__PURE__ */ u("label", {
						class: "autos-field autos-add",
						children: [/* @__PURE__ */ u("span", { children: "add a step" }), /* @__PURE__ */ u("select", {
							value: "",
							onChange: (e) => {
								const v = e.currentTarget.value;
								if (v) edit((d) => ({
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
					}),
					/* @__PURE__ */ u("div", {
						class: "autos-block",
						children: [/* @__PURE__ */ u("div", {
							class: "autos-line",
							children: [/* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("b", { children: draft.enabled ? "switched on" : "switched off" }), draft.enabled ? null : /* @__PURE__ */ u("small", { children: "Saved, and it does nothing until it is switched on." })] }), /* @__PURE__ */ u(Switch, {
								on: draft.enabled,
								label: "switched on",
								onClick: () => set({ enabled: !draft.enabled })
							})]
						}), key ? /* @__PURE__ */ u("p", {
							class: "autos-note",
							children: "It can start or stop sessions on its own, so saving it asks for your passkey, the same one a tap on start or stop would."
						}) : null]
					}),
					existing ? /* @__PURE__ */ u(Manage, {
						a: existing,
						dirty: JSON.stringify(draft) !== opened,
						onRun,
						onDelete
					}) : null
				] })
			]
		})
	}), /* @__PURE__ */ u(Bar, { children: [err ? /* @__PURE__ */ u("p", {
		class: "autos-err",
		role: "alert",
		children: err
	}) : null, /* @__PURE__ */ u("div", {
		class: "autos-acts",
		children: [/* @__PURE__ */ u("button", {
			type: "button",
			onClick: onCancel,
			children: "cancel"
		}), /* @__PURE__ */ u("button", {
			type: "button",
			class: tab === "ask" ? null : "go",
			disabled: busy,
			onClick: save,
			children: busy ? "saving…" : "save"
		})]
	})] })] });
}
function Manage({ a, dirty, onRun, onDelete }) {
	const [sure, setSure] = d(false);
	const [running, setRunning] = d(false);
	const refused = a.running ? "It is running now." : eventOnly(a) ? "It uses the event's session, so it can only run when the event happens." : dirty ? "This runs what is saved. Save your changes first." : "";
	const run = async () => {
		setRunning(true);
		try {
			await onRun(a.id, needsPasskey(a), a.name);
		} finally {
			setRunning(false);
		}
	};
	return /* @__PURE__ */ u("section", {
		class: "autos-block",
		children: [/* @__PURE__ */ u("div", {
			class: "autos-line",
			children: [/* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("b", { children: "run it once" }), refused ? /* @__PURE__ */ u("small", { children: refused }) : needsPasskey(a) ? /* @__PURE__ */ u("small", { children: "Asks for your passkey." }) : null] }), /* @__PURE__ */ u("button", {
				type: "button",
				disabled: !!refused || running,
				onClick: run,
				children: running ? "starting…" : "run now"
			})]
		}), /* @__PURE__ */ u("div", {
			class: "autos-line",
			children: [
				/* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("b", { children: "delete this automation" }), sure ? /* @__PURE__ */ u("small", { children: "This cannot be undone." }) : null] }),
				sure ? /* @__PURE__ */ u("button", {
					type: "button",
					onClick: () => setSure(false),
					children: "keep it"
				}) : null,
				sure ? /* @__PURE__ */ u("button", {
					type: "button",
					class: "danger",
					onClick: () => onDelete(a.id),
					children: "delete it"
				}) : /* @__PURE__ */ u("button", {
					type: "button",
					onClick: () => setSure(true),
					children: "delete"
				})
			]
		})]
	});
}
function Seg({ label, value, options, onChange, cls = "" }) {
	return /* @__PURE__ */ u("div", {
		class: `seg autos-seg ${cls}`.trim(),
		role: "group",
		"aria-label": label,
		children: options.map(([v, text]) => /* @__PURE__ */ u(Tog, {
			on: value === v,
			label: text,
			onClick: () => value !== v && onChange(v)
		}, v))
	});
}
var Tog = ({ on, label, onClick }) => /* @__PURE__ */ u("button", {
	type: "button",
	class: on ? "on" : null,
	"aria-pressed": on ? "true" : "false",
	onClick,
	children: label
});
function Gone({ value, known }) {
	if (!value || known.includes(value)) return null;
	const words = value === "{project}" ? "the event's project (needs a trigger on a session)" : value === "{session}" ? "the event's session (needs a trigger on a session)" : `${value} (not in the fleet now)`;
	return /* @__PURE__ */ u("option", {
		value,
		children: words
	});
}
function Trigger({ t, fleet, onChange, onType }) {
	const sessions = fleet.find((p) => p.name === t.project)?.sessions || [];
	return /* @__PURE__ */ u("section", {
		class: "autos-block",
		children: [
			/* @__PURE__ */ u("h3", { children: "when" }),
			/* @__PURE__ */ u(Seg, {
				label: "what starts it",
				value: t.type,
				options: [["schedule", "scheduled"], ["event", "when a session changes"]],
				onChange: onType
			}),
			t.type === "schedule" ? /* @__PURE__ */ u(S, { children: [
				/* @__PURE__ */ u(Seg, {
					label: "how often",
					value: t.mode,
					options: [
						["days", "weekly"],
						["once", "once"],
						["every", "every…"]
					],
					onChange: (mode) => onChange({ mode })
				}),
				t.mode === "days" ? /* @__PURE__ */ u("div", {
					class: "seg autos-seg autos-days",
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
					].map((d) => /* @__PURE__ */ u(Tog, {
						label: DAY_NAMES[d],
						on: t.days.includes(d),
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
						children: [
							/* @__PURE__ */ u("option", {
								value: "*",
								children: "any project"
							}),
							/* @__PURE__ */ u(Gone, {
								value: t.project,
								known: ["*", ...fleet.map((p) => p.name)]
							}),
							fleet.map((p) => /* @__PURE__ */ u("option", {
								value: p.name,
								children: p.name
							}, p.name))
						]
					})]
				}),
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "session" }), /* @__PURE__ */ u("select", {
						value: t.session,
						disabled: t.project === "*",
						onChange: (e) => onChange({ session: e.currentTarget.value }),
						children: [
							/* @__PURE__ */ u("option", {
								value: "*",
								children: "any session"
							}),
							/* @__PURE__ */ u(Gone, {
								value: t.session,
								known: ["*", ...sessions.map((s) => s.name)]
							}),
							sessions.map((s) => /* @__PURE__ */ u("option", {
								value: s.name,
								children: s.lead ? `${s.name} (lead)` : s.name
							}, s.name))
						]
					})]
				}),
				/* @__PURE__ */ u("label", {
					class: "autos-field",
					children: [/* @__PURE__ */ u("span", { children: "not again for the same session within (min)" }), /* @__PURE__ */ u("input", {
						type: "number",
						inputmode: "numeric",
						min: "1",
						max: "1440",
						value: t.cooldown,
						onInput: (e) => {
							const v = e.currentTarget.value;
							onChange({ cooldown: v === "" ? "" : Number(v) });
						}
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
function Step({ s, i, n, isEvent, fleet, open, onMenu, onChange, onMove, onRemove }) {
	const d = ACTIONS[s.action];
	const has = (f) => d.needs.includes(f) || (d.optional || []).includes(f);
	const fromEvent = s.project === EVENT_PROJECT;
	const sessions = fleet.find((p) => p.name === s.project)?.sessions || [];
	const shown = fromEvent ? [] : sessions;
	return /* @__PURE__ */ u("section", {
		class: `autos-block${d.passkey ? " key" : ""}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "autos-head",
				children: [/* @__PURE__ */ u("h3", { children: [
					i + 1,
					". ",
					d.label
				] }), /* @__PURE__ */ u("button", {
					type: "button",
					class: "autos-icon",
					"aria-label": `actions for step ${i + 1}`,
					"aria-expanded": open ? "true" : "false",
					onClick: onMenu,
					children: "⋯"
				})]
			}),
			open ? /* @__PURE__ */ u("div", {
				class: "autos-step-acts",
				children: [
					/* @__PURE__ */ u("button", {
						type: "button",
						"data-move": `${i}:up`,
						disabled: !i,
						onClick: () => onMove(i - 1),
						children: "move up"
					}),
					/* @__PURE__ */ u("button", {
						type: "button",
						"data-move": `${i}:down`,
						disabled: i >= n - 1,
						onClick: () => onMove(i + 1),
						children: "move down"
					}),
					/* @__PURE__ */ u("button", {
						type: "button",
						onClick: onRemove,
						children: "remove"
					})
				]
			}) : null,
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
						/* @__PURE__ */ u(Gone, {
							value: s.project,
							known: [...isEvent ? [EVENT_PROJECT] : [], ...fleet.map((p) => p.name)]
						}),
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
						/* @__PURE__ */ u(Gone, {
							value: s.session,
							known: [...isEvent ? [EVENT_SESSION] : [], ...shown.map((x) => x.name)]
						}),
						shown.map((x) => /* @__PURE__ */ u("option", {
							value: x.name,
							children: x.lead ? `${x.name} (lead)` : x.name
						}, x.name))
					]
				})]
			}) : null,
			has("name") ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "new session's name" }), /* @__PURE__ */ u("input", {
					type: "text",
					value: s.name,
					placeholder: "review-{date}",
					autocomplete: "off",
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
					autocomplete: "off",
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
						class: "seg autos-seg",
						role: "group",
						"aria-label": "statuses",
						children: STATES.map((k) => /* @__PURE__ */ u(Tog, {
							label: k,
							on: s.status.includes(k),
							onClick: () => onChange({ status: s.status.includes(k) ? s.status.filter((x) => x !== k) : [...s.status, k] })
						}, k))
					}),
					/* @__PURE__ */ u("small", {
						class: "autos-dim",
						children: "If it is not, the run ends here. That is not an error."
					})
				]
			}) : null,
			s.action === "wait" ? /* @__PURE__ */ u("label", {
				class: "autos-field",
				children: [/* @__PURE__ */ u("span", { children: "minutes (1–60)" }), /* @__PURE__ */ u("input", {
					type: "number",
					inputmode: "numeric",
					min: "1",
					max: "60",
					value: s.minutes,
					onInput: (e) => {
						const v = e.currentTarget.value;
						onChange({ minutes: v === "" ? "" : Number(v) });
					}
				})]
			}) : null
		]
	});
}
function Ask({ draft, chat, setChat, onDraft, onApply }) {
	const { msgs, text } = chat;
	const [busy, setBusy] = d(false);
	const end = A(null);
	const setMsgs = (fn) => setChat((c) => ({
		...c,
		msgs: fn(c.msgs)
	}));
	h(() => {
		if (msgs.length) try {
			end.current?.scrollIntoView({ block: "end" });
		} catch {}
	}, [msgs.length, busy]);
	const ask = async () => {
		const t = text.trim();
		if (!t || busy) return;
		const next = [...msgs, {
			role: "user",
			text: t
		}];
		setChat({
			msgs: next,
			text: ""
		});
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
			setChat((c) => ({
				msgs: [...msgs, {
					role: "ai",
					text: e.message,
					error: true
				}],
				text: c.text || t
			}));
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u("section", {
		class: "autos-block autos-ask",
		children: [
			!msgs.length ? /* @__PURE__ */ u("p", {
				class: "autos-dim",
				children: "Say it in a sentence: \"every weekday at 09:00, wake the workers in acme-api and tell the lead to share out what is open\". It fills in the steps. You check them and save."
			}) : null,
			msgs.map((m, i) => /* @__PURE__ */ u("div", {
				class: `autos-msg ${m.role}${m.error ? " bad" : ""}`,
				role: m.error ? "alert" : null,
				children: [m.text, m.automation ? /* @__PURE__ */ u(Proposal, {
					a: m.automation,
					replaces: draft.steps.length > 0,
					onApply: () => onApply(m.automation)
				}) : null]
			}, i)),
			busy ? /* @__PURE__ */ u("div", {
				class: "autos-msg ai autos-dim",
				children: "writing it…"
			}) : null,
			/* @__PURE__ */ u("div", { ref: end }),
			/* @__PURE__ */ u("div", {
				class: "autos-compose",
				children: [/* @__PURE__ */ u("textarea", {
					rows: 2,
					value: text,
					placeholder: "what should happen, and when?",
					"aria-label": "what should happen, and when?",
					onInput: (e) => {
						const v = e.currentTarget.value;
						setChat((c) => ({
							...c,
							text: v
						}));
					}
				}), /* @__PURE__ */ u("button", {
					type: "button",
					disabled: busy || !text.trim(),
					onClick: ask,
					children: "ask"
				})]
			})
		]
	});
}
function Proposal({ a, replaces, onApply }) {
	return /* @__PURE__ */ u("div", {
		class: "autos-proposal",
		children: [
			/* @__PURE__ */ u("b", { children: a.name }),
			/* @__PURE__ */ u("p", {
				class: "autos-say",
				children: describeTrigger(a.trigger)
			}),
			/* @__PURE__ */ u("ol", {
				class: "autos-steps full",
				children: (a.steps || []).map((s, i) => /* @__PURE__ */ u("li", { children: describeStep(s) }, i))
			}),
			needsPasskey(a) ? /* @__PURE__ */ u("p", {
				class: "autos-note",
				children: "It can start or stop sessions on its own, so saving it asks for your passkey."
			}) : null,
			/* @__PURE__ */ u("button", {
				type: "button",
				class: "go",
				onClick: onApply,
				children: replaces ? "replace the steps with this" : "put it in the editor"
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
