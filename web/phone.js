import { a as d, c as q, d as S$1, f as X, i as _, l as x, n as A, o as g, r as T, s as h, t as u, u as R } from "./preact.js";
import * as api$1 from "./api.js";
import * as passkey from "./passkey.js";
import { render } from "./md.js";
import { render as render$1 } from "./ansi.js";
//#region web/src/push.js
function standalone() {
	try {
		if (matchMedia("(display-mode: standalone)").matches) return true;
	} catch {}
	return navigator.standalone === true;
}
var supported = () => !!(navigator.serviceWorker && typeof window !== "undefined" && "PushManager" in window && typeof Notification !== "undefined");
function permission() {
	try {
		return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
	} catch {
		return "unsupported";
	}
}
function iosLike() {
	const ua = navigator.userAgent || "";
	return /iPad|iPhone|iPod/.test(ua) || navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
}
function blockedReason(tr) {
	if (api$1.mode() === "probing") return tr("push.probing");
	if (api$1.mode() !== "server") return tr("push.fixtures");
	if (!supported()) return iosLike() && !standalone() ? tr("push.iosTab") : tr("push.noApi");
	if (iosLike() && !standalone()) return tr("push.iosTab");
	if (permission() === "denied") return tr("push.denied");
	return "";
}
var LATER_KEY = "gf.push.later";
function offerWanted({ server, token, blocked, laterAt = 0, now = Date.now(), on }) {
	if (!server || !token || blocked) return false;
	if (now - (Number(laterAt) || 0) < 2592e5) return false;
	return !on;
}
var b64uToBytes = (s) => {
	const pad = s.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(pad + "=".repeat((4 - pad.length % 4) % 4));
	return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};
async function registration() {
	if (!navigator.serviceWorker) return null;
	try {
		return await navigator.serviceWorker.ready;
	} catch {
		return null;
	}
}
async function current() {
	const reg = await registration();
	if (!reg || !reg.pushManager) return null;
	try {
		return await reg.pushManager.getSubscription();
	} catch {
		return null;
	}
}
var swVersion = "";
function shellVersion() {
	return swVersion;
}
async function askShellVersion() {
	try {
		const c = navigator.serviceWorker && navigator.serviceWorker.controller;
		if (!c) {
			swVersion = "no worker";
			return swVersion;
		}
		const ch = new MessageChannel();
		swVersion = await new Promise((res) => {
			const tm = setTimeout(() => res("unknown"), 600);
			ch.port1.onmessage = (e) => {
				clearTimeout(tm);
				res(e.data && e.data.version || "unknown");
			};
			c.postMessage({ type: "version" }, [ch.port2]);
		});
	} catch {
		swVersion = "unknown";
	}
	return swVersion;
}
async function cacheName() {
	if (/^ghostfleet-v/.test(swVersion)) return swVersion;
	try {
		const hit = (await caches.keys()).find((k) => /^ghostfleet-v/.test(k));
		if (hit) return hit;
	} catch {}
	return "ghostfleet-push";
}
async function enable(tr) {
	const why = blockedReason(tr);
	if (why) throw new Error(why);
	if (await Notification.requestPermission() !== "granted") throw new Error(tr("push.notAllowed"));
	const k = await api$1.pushKey();
	if (!k || !k.key) throw new Error(tr("push.noKey"));
	const reg = await registration();
	if (!reg || !reg.pushManager) throw new Error(tr("push.noWorker"));
	const sub = await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: b64uToBytes(k.key)
	});
	try {
		await (await caches.open(await cacheName())).put("./__push-key", new Response(k.key));
	} catch {}
	const j = sub.toJSON ? sub.toJSON() : sub;
	await api$1.pushSubscribe({
		endpoint: j.endpoint,
		keys: j.keys
	});
	try {
		localStorage.setItem("gf.push.endpoint", j.endpoint);
	} catch {}
	return j.endpoint;
}
async function disable() {
	const sub = await current();
	const ep = sub ? sub.endpoint || "" : "";
	try {
		if (ep) await api$1.pushUnsubscribe(ep);
	} catch {}
	try {
		if (sub) await sub.unsubscribe();
	} catch {}
	try {
		localStorage.removeItem("gf.push.endpoint");
	} catch {}
}
async function state(tr) {
	const why = blockedReason(tr);
	if (why) return {
		ready: false,
		why
	};
	const sub = await current();
	let known = false;
	try {
		known = !!(sub && (await api$1.pushKey())?.subscribed);
	} catch {}
	return {
		ready: true,
		on: !!sub && known,
		why: sub && !known ? tr("push.unknownThere") : ""
	};
}
var synced = false;
async function sync() {
	if (synced || !api$1.haveToken() || api$1.mode() !== "server") return;
	synced = true;
	try {
		try {
			const c = await caches.open(await cacheName());
			const pending = await c.match("./__push-pending");
			if (pending) {
				const j = await pending.json();
				if (j && j.endpoint && j.keys) {
					await api$1.pushSubscribe({
						endpoint: j.endpoint,
						keys: j.keys
					});
					try {
						localStorage.setItem("gf.push.endpoint", j.endpoint);
					} catch {}
				}
				await c.delete("./__push-pending");
			}
		} catch {}
		const sub = await current();
		if (!sub) return;
		const j = sub.toJSON ? sub.toJSON() : sub;
		let last = "";
		try {
			last = localStorage.getItem("gf.push.endpoint") || "";
		} catch {}
		if (j.endpoint && j.endpoint !== last) {
			await api$1.pushSubscribe({
				endpoint: j.endpoint,
				keys: j.keys
			});
			try {
				localStorage.setItem("gf.push.endpoint", j.endpoint);
			} catch {}
		}
	} catch {}
}
//#endregion
//#region web/ui/adapter.jsx
var Fleet = X(null);
function FleetProvider({ adapter, children }) {
	return /* @__PURE__ */ u(Fleet.Provider, {
		value: adapter,
		children
	});
}
function useFleet() {
	const a = x(Fleet);
	if (!a) throw new Error("web/ui: a shared screen was rendered outside <FleetProvider>");
	return a;
}
var none = () => null;
function useSlot(name, fallback = none) {
	const s = useFleet().slots;
	return s && s[name] || fallback;
}
//#endregion
//#region web/ui/keys.js
var typingIn = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || !!t.isContentEditable);
var SOFTLESS_KEY = /^(Escape|Tab|Arrow|F\d{1,2}$|Shift$|Control$|Alt$|Meta$|CapsLock$|Home$|End$|PageUp$|PageDown$)/;
function finePointer() {
	try {
		return !!matchMedia("(hover: hover) and (pointer: fine)").matches;
	} catch {
		return false;
	}
}
var vvTallest = 0;
var vvWidth = 0;
function measuredSoftKeyboard() {
	try {
		const vv = globalThis.visualViewport;
		if (!vv) return false;
		const h = Number(vv.height) || 0, w = Math.round(Number(vv.width) || 0);
		if (w !== vvWidth) {
			vvWidth = w;
			vvTallest = 0;
		}
		vvTallest = Math.max(vvTallest, h, Number(globalThis.innerHeight) || 0);
		return vvTallest - h > 120;
	} catch {
		return false;
	}
}
try {
	measuredSoftKeyboard();
	globalThis.visualViewport?.addEventListener("resize", measuredSoftKeyboard);
} catch {}
var softProbe = measuredSoftKeyboard;
function setSoftKeyboardProbe(fn) {
	softProbe = typeof fn === "function" ? fn : measuredSoftKeyboard;
}
var hwKeyboard = false;
function noteKeyboard(e) {
	if (hwKeyboard || !e || e.isTrusted !== true) return;
	if (!typingIn(e.target) || SOFTLESS_KEY.test(e.key || "") || e.ctrlKey || e.metaKey || e.altKey || !softProbe()) hwKeyboard = true;
}
function enterSends() {
	return finePointer() || hwKeyboard;
}
function sendsOnEnter(e) {
	return !!e && e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && enterSends();
}
function deskKey(e) {
	const k = e && e.key;
	if (!k || e.metaKey || e.isComposing || e.keyCode === 229) return null;
	if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta" || k === "Dead" || k === "Process") return null;
	return {
		k,
		lk: k.length === 1 ? k.toLowerCase() : k,
		ctrl: !!e.ctrlKey && !e.altKey,
		shift: !!e.shiftKey,
		alt: !!e.altKey
	};
}
function deskKeyInComposer(e, { held = false, stack = false } = {}) {
	if (held) return true;
	if (!e || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return false;
	const k = e.key, lk = k && k.length === 1 ? k.toLowerCase() : k;
	const t = e.target, sel = !!t && Number.isInteger(t.selectionStart) && t.selectionStart !== t.selectionEnd;
	if (e.ctrlKey && lk === "x") return stack && !sel;
	if (e.ctrlKey) return lk === "s" || lk === "p" || lk === "f" || lk === "a";
	if (k === "`") return true;
	return !!e.shiftKey && (k === "ArrowLeft" || k === "ArrowRight");
}
function jumpStep(j, key) {
	const { k, lk, ctrl } = key;
	const digit = !ctrl && /^[1-9]$/.test(k);
	if (k === "Escape" || ctrl && (lk === "f" || lk === "c")) return {
		j: null,
		go: null
	};
	if (j.stage === "first") {
		if (digit) return {
			j: {
				stage: "proj",
				proj: Number(k)
			},
			go: null
		};
		if (!ctrl && lk === "s") return {
			j: { stage: "grid" },
			go: null
		};
		if (!ctrl && lk === "p") return {
			j: null,
			go: { to: "projects" }
		};
		return {
			j: null,
			go: null
		};
	}
	if (j.stage === "grid") return {
		j: null,
		go: digit ? {
			to: "grid",
			project: Number(k)
		} : null
	};
	if (digit) return {
		j: null,
		go: {
			to: "card",
			project: j.proj,
			card: Number(k)
		}
	};
	if (k === "Enter" || !ctrl && lk === "m") return {
		j: null,
		go: {
			to: "master",
			project: j.proj
		}
	};
	if (!ctrl && lk === "s") return {
		j: null,
		go: {
			to: "grid",
			project: j.proj
		}
	};
	return {
		j: null,
		go: null
	};
}
function stepIndex(rects, from, dir) {
	const n = rects.length;
	if (!n) return -1;
	if (from < 0 || from >= n) return 0;
	if (dir === "left") return from > 0 ? from - 1 : -1;
	if (dir === "right") return from < n - 1 ? from + 1 : -1;
	const a = rects[from], mid = a.top + a.height / 2, cx = a.left + a.width / 2;
	const down = dir === "down";
	const beyond = [];
	for (let i = 0; i < n; i++) {
		const r = rects[i];
		if (i === from || !r.width || !r.height) continue;
		if (down ? r.top > mid : r.bottom < mid) beyond.push(i);
	}
	if (!beyond.length) return -1;
	const edge = (i) => down ? rects[i].top : -rects[i].bottom;
	const near = Math.min(...beyond.map(edge));
	const row = beyond.filter((i) => edge(i) - near < Math.max(4, a.height / 2));
	let best = row[0], bestD = Infinity;
	for (const i of row) {
		const d = Math.abs(rects[i].left + rects[i].width / 2 - cx);
		if (d < bestD) {
			best = i;
			bestD = d;
		}
	}
	return best;
}
var DIRS = {
	ArrowLeft: "left",
	h: "left",
	ArrowRight: "right",
	l: "right",
	ArrowUp: "up",
	k: "up",
	ArrowDown: "down",
	j: "down"
};
function cycleName(names, current, d) {
	if (!names.length) return null;
	const i = names.indexOf(current);
	if (i < 0) return names[0];
	return names[(i + d + names.length) % names.length];
}
//#endregion
//#region web/ui/viewport.js
var tallest = 0;
var width = 0;
var up = false;
var typingInto = () => {
	const a = typeof document !== "undefined" ? document.activeElement : null;
	return !!a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable);
};
function syncViewport() {
	try {
		const vv = globalThis.visualViewport;
		if (!vv || typeof document === "undefined") return;
		const h = Number(vv.height) || 0, w = Math.round(Number(vv.width) || 0);
		if (w !== width) {
			width = w;
			tallest = 0;
		}
		tallest = Math.max(tallest, h, Number(globalThis.innerHeight) || 0);
		up = tallest - h > 120 && typingInto();
		const root = document.documentElement;
		const list = document.querySelector(".chat");
		const atEnd = !!list && list.scrollHeight - list.clientHeight - list.scrollTop < 4;
		if (up) {
			root.classList.add("kb");
			root.style.setProperty("--app-top", Math.round(Number(vv.offsetTop) || 0) + "px");
			root.style.setProperty("--app-h", Math.round(h) + "px");
		} else {
			root.classList.remove("kb");
			root.style.removeProperty("--app-top");
			root.style.removeProperty("--app-h");
		}
		if (atEnd) list.scrollTop = list.scrollHeight;
	} catch {}
}
if (typeof document !== "undefined") {
	syncViewport();
	try {
		globalThis.visualViewport?.addEventListener("resize", syncViewport);
		globalThis.visualViewport?.addEventListener("scroll", syncViewport);
		addEventListener("resize", syncViewport);
		addEventListener("focusout", () => setTimeout(syncViewport, 0));
	} catch {}
	setSoftKeyboardProbe(() => up);
}
//#endregion
//#region web/ui/words/en.js
var en_default = {
	"sched.default": "continue",
	"status.need-you": "Needs you",
	"status.need-you.hint": "Waiting for an answer or a permission",
	"status.working": "Working",
	"status.working.hint": "Claude is in the middle of a turn",
	"status.ready": "Ready",
	"status.ready.hint": "It finished its turn; check what it did",
	"status.parked": "Paused",
	"status.parked.hint": "Paused on purpose; it uses no quota",
	"status.idle": "Idle",
	"status.idle.hint": "Open, with no task",
	"status.starting": "Starting",
	"status.starting.hint": "It is opening",
	"status.limit": "Out of quota",
	"status.limit.hint": "It hit the account's usage limit",
	"status.interrupted": "Interrupted",
	"status.interrupted.hint": "Its turn was cut short",
	"status.unknown": "No data",
	"status.unknown.hint": "Its state could not be read",
	"status.asleep": "Asleep",
	"status.asleep.hint": "Hibernated; one click wakes it",
	"status.lost": "Lost",
	"status.lost.hint": "The machine closed its process; it can be reopened",
	"ago.now": "now",
	"ago.min": "{n} min ago",
	"ago.h": "{n} h ago",
	"ago.d": "{n} d ago",
	"common.ok": "OK",
	"common.close": "Close",
	"common.cancel": "Cancel",
	"common.wait": "One moment…",
	"common.loading": "Loading…",
	"common.save": "Save",
	"ui.typeTo.a": "Type ",
	"ui.typeTo.b": " to confirm",
	"nav.label": "Navigation",
	"nav.home": "Home",
	"nav.map": "Live map",
	"nav.projects": "Projects",
	"nav.search": "Search…",
	"nav.searchProject": "Search project",
	"nav.menu": "Menu",
	"auth.name": "Name",
	"light.work": "Working",
	"light.start": "Starting",
	"light.wait": "Needs you",
	"light.error": "In trouble",
	"light.done": "Ready",
	"light.idle": "Open",
	"light.off": "Asleep",
	"common.lead": "lead",
	"map.opened": "{project}: {session} opened",
	"map.closed": "{project}: {session} closed",
	"map.sub": "The whole fleet at once. The ghost ship goes wherever something is happening.",
	"map.showIdle": "Show projects with no sessions ({n})",
	"map.reading": "Reading the fleet…",
	"map.none": "No project has open sessions.",
	"map.noSessions": "no sessions",
	"map.live": "Live",
	"map.waiting": "Waiting for movement in the fleet… every session that opens, finishes or needs you shows up here.",
	"look.need": "Needs you",
	"look.work": "Working",
	"look.fresh": "Just finished",
	"look.warn": "Out of quota / cut off",
	"look.open": "Open",
	"look.off": "Idle",
	"board.open": "Open {name}",
	"tip.agent": "Agent",
	"tip.owner": "Owner",
	"tip.label": "Label",
	"tip.moved": "Moved",
	"tip.said": "Said",
	"board.none": "No fleet is working right now.",
	"board.quiet": "{n} quiet",
	"group.need.title": "Need you",
	"group.need.hint": "Waiting for an answer or a permission",
	"group.work.title": "Working",
	"group.work.hint": "In the middle of a turn",
	"group.ready.title": "Ready to review",
	"group.ready.hint": "They finished their turn",
	"group.rest.title": "Paused or idle",
	"group.rest.hint": "Not using quota",
	"project.branch": "Branch",
	"project.queued": "{n} queued",
	"project.rmTitle": "Delete free worktree",
	"project.rmAction": "Delete worktree",
	"project.rmBody.a": "This deletes the folder ",
	"project.rmBody.b": " (branch ",
	"project.rmBody.c": "). ghostfleet refuses if it has unsaved or unpushed changes, and tells you why.",
	"project.rmDone": "Worktree deleted",
	"project.leadReady": "The lead is ready.",
	"project.leadWasOpen": "The lead was already open.",
	"project.leadFailed": "Could not start the lead: {why}",
	"project.sessions": "{n} sessions",
	"project.freeWts": "{n} free worktrees",
	"project.leadIs": "The lead is the project's Claude that hands out the work",
	"project.leadStart": "Start the lead",
	"project.leadReopen": "Reopen the lead",
	"project.leadWake": "Wake the lead",
	"project.leadResume": "Resume the lead",
	"project.newSession": "New session",
	"project.new": "New",
	"project.readFailed": "Could not read {project}'s fleet: {why}",
	"project.empty": "This project has no open sessions.",
	"project.emptyWhy": "A session is a Claude working in its own worktree, on its own branch. That way two people move forward in parallel without stepping on each other.",
	"project.openFirst": "Open the first one",
	"project.tree": "Project tree",
	"project.treeHint": "The lead in the main folder and each session in its own worktree (its “children”)",
	"project.noLead": "No lead open in the main folder.",
	"project.free": "free",
	"project.openHere": "Open a session here",
	"common.delete": "Delete",
	"project.created": "Session created",
	"project.newWhy": "A worktree is created with its own branch and a Claude opens there. That way each person works in parallel without stepping on the other's work.",
	"project.namePh": "e.g. sign-in-with-google",
	"project.willBe": "It will be called",
	"project.what": "What does it have to do?",
	"project.whatPh": "Describe the whole task: what to build, where, and how to know it is done. You can leave it empty and write to it later.",
	"project.where": "Where",
	"project.newWt": "New worktree",
	"project.reuse": "Reuse {name} ({branch})",
	"project.advanced": "Advanced options",
	"project.sameAsName": "same as the name",
	"project.from": "Start from",
	"project.fromPh": "the repo's base branch",
	"project.model": "Model",
	"project.accountModel": "The account's",
	"common.creating": "Creating…",
	"project.create": "Create session",
	"sess.opt.yesAlways": "Yes, and don't ask again",
	"sess.opt.yesEdits": "Yes, allow every edit in this session",
	"sess.opt.yes": "Yes, allow",
	"sess.opt.no": "No, tell it something else",
	"sess.asksPermission": "Claude asks for permission",
	"sess.aTool": "a tool",
	"sess.checkCmd": "Check the command before allowing it: it runs in this session's worktree, with your account.",
	"sess.asks": "Claude asks you",
	"sess.qOf": "question {i} of {n}",
	"sess.review": "review and send",
	"sess.yourAnswer": "Type your answer",
	"common.send": "Send",
	"sess.readingTerm": "Reading the terminal…",
	"sess.older": "Load earlier messages",
	"sess.noMsgs": "No messages in this session yet.",
	"sess.actions": "{n} actions",
	"sess.instruction": "Instruction",
	"sess.queuedMsg": "Queued · delivered when the turn ends",
	"sched.in30": "In 30 min",
	"sched.in1h": "In 1 hour",
	"sched.in3h": "In 3 hours",
	"sched.tomorrow": "Tomorrow 9:00",
	"sched.title": "Schedule a message for {name}",
	"sched.why": "At the time you pick, ghostfleet writes this message to the session, even if nobody is watching. Useful to pick up after the usage limit or to leave something for tomorrow.",
	"sched.message": "Message",
	"sched.exact": "…or at an exact time",
	"sched.go": "Schedule",
	"sess.queuedQ": "Queued: the session has a pending question. Answer it first.",
	"sess.queuedTurn": "Queued: delivered when the current turn ends.",
	"sess.changed": "The request changed while you were looking at it; nothing was sent. Check again.",
	"sess.maxFiles": "Up to {n} files per message.",
	"sess.pasted": "pasted image",
	"sess.attaching": "Here are some files for you.",
	"sess.filesLost": "{n} files attached to this draft did not survive the reload. Attach them again.",
	"sess.filesLost.one": "A file attached to this draft did not survive the reload. Attach it again.",
	"sess.attached": "Attached files (open them from these paths)",
	"sess.stopRmTitle": "Stop and delete the worktree",
	"sess.stopTitle": "Stop the session",
	"sess.stopRm": "Stop and delete",
	"sess.stop": "Stop",
	"sess.stopRmBody.a": "This closes ",
	"sess.stopRmBody.b": " and deletes its worktree. ghostfleet only deletes it if there are no unsaved changes and the branch is pushed or merged; otherwise it stops it anyway and leaves the folder, saying why.",
	"sess.stopBody.b": " for good. Its worktree and branch stay as they are, and the conversation is kept.",
	"sess.stopped": "Stopped",
	"common.back": "Back",
	"common.backTo": "Back to {place}",
	"sess.changeLabel": "Change label",
	"sess.schedMsg": "Scheduled message: {msg}",
	"sess.unsched": "Cancel schedule",
	"sess.interruptHint": "Cuts the current turn short, like pressing Esc",
	"sess.interrupt": "Interrupt",
	"sess.wake": "Wake",
	"sess.reopen": "Reopen",
	"sess.resume": "Resume",
	"sess.pause": "Pause",
	"sess.more": "More",
	"sess.setLabel": "Add a label…",
	"sess.schedule": "Schedule a message…",
	"sess.renameMenu": "Rename…",
	"sess.stopMenu": "Stop session…",
	"sess.stopRmMenu": "Stop and delete worktree…",
	"sess.quotaBack": "quota is back {when}",
	"sess.limitWhy": "Until then it cannot go on. You can schedule it to pick up on its own.",
	"sess.alreadySched": "Already scheduled for {when}.",
	"sess.continueMsg": "carry on with the task where you left it",
	"sess.resumeOnQuota": "Pick up on its own when the quota is back",
	"sess.otherTime": "Pick another time…",
	"sess.chat": "Chat",
	"sess.screen": "Screen",
	"sess.screenHint": "Read only: what the agent's own terminal shows right now",
	"term.tab.term": "Terminal",
	"term.tab.edit": "Editor",
	"term.tab.sessions": "Sessions",
	"term.cap.term": "{project}'s own terminal, the same tab from every session",
	"term.cap.edit": "{project}'s own editor, the same tab from every session",
	"term.opening": "opening…",
	"term.leave.term": "Leave terminal",
	"term.leave.edit": "Leave editor",
	"term.enter.term": "Type in terminal",
	"term.enter.edit": "Type in editor",
	"term.smaller": "Smaller text",
	"term.larger": "Larger text",
	"term.keyboard": "Keyboard",
	"term.copied": "Copied",
	"term.reconnect": "Reconnect",
	"term.openAgain": "Open again",
	"term.idle": "Closed after {min} min idle",
	"term.idleWhy": "Nothing is lost: the tab stays open, and Reconnect picks it up where it was.",
	"term.takeover.term": "Opened in another tab",
	"term.takeover.edit": "Opened in another tab",
	"term.takeoverWhy": "Only one window at a time types here, and another of yours just opened this tab.",
	"term.failed": "Could not connect",
	"term.dropped": "The connection dropped",
	"term.ended.term": "The shell ended",
	"term.ended.edit": "The editor closed",
	"term.failedWhy": "The server did not take the connection. Open again tries once more.",
	"term.droppedWhy": "The tab is still running on the server, and Open again picks it up.",
	"term.endedWhy": "Open again starts a new one in the project's folder.",
	"term.noEditor": "No editor on this machine",
	"term.password": "Change your password first",
	"term.passwordWhy": "Your account still has a temporary password, and this tab opens once it is changed.",
	"term.changePassword": "Change password",
	"term.signedOut": "You are signed out",
	"term.signedOutWhy": "The sign-in on this browser ended.",
	"term.signIn": "Sign in",
	"term.refused": "The server refused the connection",
	"term.off": "The terminal is off for this device",
	"term.offWhy": "Settings turns it on. It asks for the passkey, and the server records which device did it.",
	"term.openSettings": "Settings",
	"sess.readFailed": "Could not read the conversation: {why}",
	"chat.slowDown": "the server asked this device to slow down",
	"chat.offline": "the server is not answering",
	"chat.noAnswer": "the server has not answered yet",
	"chat.loadFailed": "Could not load the conversation — {why} · retrying",
	"chat.olderLoading": "Loading earlier messages…",
	"chat.olderFailed": "Earlier messages did not load — {why}",
	"chat.start": "Start of conversation",
	"acct.workers.paused": "workers paused",
	"acct.workers.running": "workers keep running (budget ignored)",
	"acct.workers.mixed": "workers paused, except where the budget is ignored",
	"acct.until": " until {at}",
	"acct.resets": "{label} {pct}% (resets {at}, read {read})",
	"acct.off": "accounts are off",
	"acct.none": "accounts: no profile has an account yet",
	"acct.exhausted": "all accounts exhausted{until} — {workers}",
	"acct.unsaved": "on a login that is not saved — failover paused",
	"acct.noActive": "no account is active",
	"acct.read": "read {when}",
	"acct.never": "never",
	"acct.open": "Claude accounts: open every account",
	"acct.title": "Claude accounts",
	"acct.threshold": "switch at {pct}% of the 5h or 7d limit, spending the week that ends first",
	"acct.noProfile": "no profile has an account yet — fleet-accounts add <profile> <name>",
	"acct.profUnsaved": " — ON A LOGIN THAT IS NOT SAVED, failover paused (fleet-accounts add to manage it)",
	"acct.profExhausted": " — ALL EXHAUSTED{until}, {workers}",
	"acct.noAccounts": "(no accounts)",
	"acct.one": "one account: nothing to fail over to yet — add another",
	"acct.pin": "on '{account}' by hand until {at} — the planner leaves it there unless it runs out",
	"acct.readOnly": "read only — an account is switched at the desk: fleet-accounts use <profile> <name>",
	"acct.activeTag": " (active)",
	"sess.uploading": "uploading…",
	"sess.notUploaded": "not uploaded",
	"sess.remove": "Remove {name}",
	"sess.attach": "Attach files or images",
	"sess.drop": "Drop the files here…",
	"sess.pendingAbove": "There is a pending request above; what you write is queued until it is answered.",
	"sess.writeTo": "Write to {name}…  (attach or drag a file · Enter sends)",
	"sess.uploadingBtn": "Uploading…",
	"sess.labelTitle": "Session label",
	"sess.labelWhy": "A short note to recognise it at a glance, like “client urgent” or “waiting on review”. It shows on the card and in the terminal. Empty removes it.",
	"sess.labelField": "Label (up to 40 characters)",
	"sess.renameTitle": "Rename session",
	"sess.newName": "New name",
	"sess.rename": "Rename",
	"keys.jump.first": "jump → project? 1-9  ·  s + digit = that project's sessions  ·  p = home  ·  esc",
	"keys.jump.proj": "jump → project {n}: session? 1-9  ·  ⏎ or m = lead  ·  s = its sessions  ·  esc",
	"keys.jump.grid": "jump → sessions of project? 1-9  ·  esc",
	"task.missed": "It did not reach {project}.",
	"nav.automations": "Automations",
	"nav.activity": "Activity",
	"nav.settings": "Settings",
	"as.open": "Open the voice assistant",
	"as.name": "Assistant",
	"settings.language": "Language",
	"verb.fleet_send": "wrote to",
	"verb.attach": "attached a file to",
	"verb.fleet_answer": "answered a request from",
	"verb.fleet_interrupt": "interrupted",
	"verb.fleet_pause": "paused",
	"verb.fleet_resume": "resumed",
	"verb.fleet_wake": "woke",
	"verb.fleet_reopen": "reopened",
	"verb.fleet_spawn": "created the session",
	"verb.fleet_stop": "stopped",
	"verb.fleet_rename": "renamed",
	"verb.fleet_worktree_remove": "deleted the worktree",
	"verb.fleet_unqueue": "took a queued message off",
	"verb.assign": "changed the owner of",
	"verb.login": "signed in",
	"verb.setup": "created the accounts",
	"verb.add_user": "added",
	"verb.password": "changed their password",
	"verb.auto_save": "saved the automation",
	"verb.auto_delete": "deleted the automation",
	"verb.route": "(assistant) decided about",
	"verb.voice_install": "downloaded the voice",
	"verb.voice_delete": "deleted the voice",
	"result.ran": "done",
	"result.refused": "refused",
	"result.changed": "the request changed",
	"activity.title": "Activity",
	"activity.sub": "Everything done from the web, with name and time.",
	"activity.empty": "No activity yet.",
	"settings.title": "Settings",
	"settings.languageHint": "The app and the assistant speak to you in this language, on every device.",
	"settings.you": "you",
	"settings.connection": "Connection",
	"settings.demoReset": "Demo reset",
	"settings.resetDemo": "Reset demo data",
	"project.filter": "Filter by owner",
	"common.and": " and ",
	"task.state.ask": "Where does it go?",
	"task.state.failed": "Did not arrive",
	"task.state.need-you": "Needs you",
	"task.state.replied": "Replied",
	"task.state.working": "Working",
	"task.state.sent": "Sent",
	"task.state.sending": "Sending…",
	"task.other": "other…",
	"task.tickAria": "Mark as done: {title}",
	"task.tick": "Done, take it off the list",
	"task.title": "Requests",
	"task.clear": "Clear replied",
	"task.hide": "Hide requests",
	"task.deciding": "Working out where it goes…",
	"task.see": "See requests: {n}",
	"ship.listening": "Listening…",
	"ship.hearing": "Transcribing…",
	"ship.routing": "Working out where it goes…",
	"ship.sending": "Sending…",
	"ship.starting": "Waking the lead…",
	"ship.thinking": "Thinking…",
	"ship.acting": "Working",
	"ship.speaking": "Speaking",
	"ship.idle": "Ready",
	"ship.off": "No lead open",
	"as.doneTalking": "Finish talking",
	"as.talk": "Talk",
	"as.listenManual": "Listening — tap when you're done",
	"as.listenAuto": "Listening — take your time",
	"as.stopAll": "Stop everything",
	"as.typeBig": "Type to it: “go to acme-web, check the payment tests”…",
	"as.type": "…or type here",
	"as.voiceOpts": "Voice options",
	"as.vsChecking": "Checking the voice…",
	"as.vsLocal": "Local voice: transcribed on this machine, the audio never leaves it.",
	"as.vsBrowser": "Browser voice (Chrome processes it on its servers).",
	"as.vsNone": "This browser has no dictation and no local voice is installed: type to it.",
	"as.hintManual": "I won't cut you off even if you pause. Tap ✓ when you're done.",
	"as.hintAuto": "You can pause to think: I send when you are quiet for {s} seconds, or tap ✓.",
	"as.sLong": "4.5",
	"as.sShort": "2.5",
	"as.whenPause": "When I pause:",
	"as.voiceOut": "Reply out loud",
	"as.handsFree": "Conversation (listens again after replying)",
	"as.follow": "Take me to the session where it is working",
	"as.question": "question",
	"as.live": "live",
	"as.in": "in {where}",
	"as.laneEmpty": "No open sessions: when you ask for something I start its lead.",
	"as.hint.title": "Talk to it like a teammate.",
	"as.hint.examples": "“Go to acme-api” · “In billing-svc check the invoice tests” · “Open the session payments” · “Show me the map”.",
	"as.hint.how": "Everything goes through the dispatcher first: it reads the conversation and picks a single destination. If it is not sure, it asks you before sending.",
	"as.sub": "decides where each thing goes and, if in doubt, asks you",
	"as.pickVoice": "Choose voice",
	"as.close": "Close assistant",
	"as.talkingTo": "Talking to",
	"as.auto": "Auto",
	"as.leadOf": "{project} lead",
	"as.leadLater": "{project} lead (not open yet)",
	"as.today": "What are we doing today?",
	"as.proposals": "Waiting on your yes",
	"as.proposal": "Jarvis asks: {summary}?",
	"as.proposalGranted": "Yes given: {summary}",
	"as.proposalYes": "Yes",
	"as.proposalNo": "No",
	"as.proposalYesDone": "Yes. Jarvis will {summary}.",
	"as.proposalNoDone": "No. Jarvis will not {summary}.",
	"as.conversing": "in conversation",
	"as.done": "I'm done",
	"pause.normal": "Wait for a 2.5 s pause and send",
	"pause.larga": "Wait for a long pause (4.5 s), to think",
	"pause.manual": "Don't cut on my own: wait until you tap “I'm done”",
	"voice.micDenied": "The browser did not grant microphone access. Turn it on from the padlock in the address bar.",
	"voice.micDeniedShort": "The browser did not grant microphone access.",
	"voice.transcribeFailed": "Could not transcribe: {why}",
	"voice.needsNet": "The browser's dictation needs the internet.",
	"voice.dictation": "Dictation: {why}",
	"voice.code": "(code)",
	"agent.frame.voice": "{name}, by voice from {app}.",
	"agent.frame.typed": "{name}, through the assistant from {app}.",
	"agent.frame.ask": "Reply briefly and in English (it is read aloud). If the task is big, split it into new sessions (fleet_spawn) and tell me what you opened.",
	"agent.heardNothing": "I heard nothing, so I stopped listening. Tap Talk to go on.",
	"agent.passed": "Done, I passed it {who}.",
	"agent.missed": "It did not arrive: {why}",
	"agent.dupe": "I already got that; I will not send it twice.",
	"agent.routeFailed": "I could not decide where “{text}” goes: {why}. Tell me again.",
	"agent.routeFailedSay": "I could not decide where that goes. Tell me again.",
	"agent.here": "Done, we are in {project}. What shall we do?",
	"agent.noted": "Done, I noted {n}: {list}.",
	"agent.unsure": "And {n} I do not know where they go: they are on the list.",
	"agent.toSession": "to {session}, in {project}",
	"agent.toLead": "to the lead of {project}",
	"agent.going": "Going {who}.",
	"agent.goingWhy": "Going {who}: {why}",
	"agent.leadStarted": "I started the lead of {project}.",
	"agent.leadWoke": "I woke the lead of {project}.",
	"agent.leadFailed": "I could not start the lead of {project}: {why}",
	"agent.earlier": "What I said before: {earlier}",
	"agent.queuedQ": "Queued: the lead has a pending question.",
	"agent.queuedTurn": "Queued: the lead finishes its turn and takes it.",
	"agent.missedAt": "It did not reach {project}: {why}",
	"agent.from": "From {project}.",
	"agent.fromAbout": "From {project}, about {title}.",
	"agent.opened": "Session {name} opened",
	"agent.leadIs": "The lead is {word}",
	"cmd.map": "Opening the live map.",
	"cmd.home": "Going home.",
	"cmd.activity": "Opening the activity.",
	"cmd.open": "Opening {session}.",
	"cmd.openIn": "Opening {session} in {project}.",
	"cmd.noSession": "I found no session like “{name}”.",
	"vp.hello": "Hi, this is how I sound when I answer you. What are we doing today?",
	"vp.loading": "Loading voices…",
	"vp.title": "The voice that answers you",
	"vp.listen": "Listen to {name}",
	"vp.delete": "Delete {name}",
	"vp.online": "From the internet: listen to it and, if you like it, download it",
	"vp.onlineView": "From the internet: listen to a sample; an admin can download it",
	"vp.quality": "quality {q}",
	"vp.preparing": "Preparing…",
	"vp.download": "Download",
	"vp.failed": "Could not download {name}: {why}",
	"agent.noServer": "The assistant is not connected to a server yet.",
	"agent.you": "The owner",
	"app.notHere": "This server does not have this page.",
	"settings.reading": "Reading…",
	"settings.hosts": "Paired machines",
	"settings.hostsNone": "No other machine is paired with this one.",
	"settings.hostThis": "this machine",
	"settings.hostOnline": "answering",
	"settings.hostOffline": "not answering",
	"settings.unpaired": "{name} is no longer paired.",
	"settings.unpair": "Unpair",
	"settings.unpairQ": "Unpair…",
	"settings.backend": "Talk to",
	"settings.device": "This device",
	"settings.push": "Notifications",
	"settings.pushLabel": "Tell this device when a session needs you",
	"settings.terminal": "Terminal and editor",
	"settings.terminalLabel": "Allow a terminal and an editor from this device",
	"settings.about": "About",
	"settings.serverUrl": "Server address",
	"settings.useServer": "Use this server",
	"lock.tagline": "your fleet, in your pocket",
	"lock.noPasskey": "This needs a passkey: {why}",
	"lock.enrolHint": "register one on the lock screen first",
	"lock.unavailable": "No passkey on this device: {why}",
	"lock.fixturesGate": "Demo data: nothing here reaches a real machine.",
	"lock.asking": "Asking {where} whether an enrolment window is open…",
	"lock.askFailed": "Could not ask whether enrolment is open: {why}",
	"lock.windowOpen": "An enrolment window is open for {client}.",
	"lock.windowClosed": "{how}: it prints a one-time code, good for 15 minutes and one use. Case and the hyphen do not matter.",
	"lock.code": "One-time code",
	"lock.register": "Register a passkey",
	"lock.unlocking": "Unlocking…",
	"lock.unlock": "Unlock with {sensor}",
	"lock.bypass": "Continue without a passkey",
	"lock.lookAgain": "Look for the server again",
	"lock.where": "Which server?",
	"phone.noLead": "{project} has no lead to start from this phone.",
	"phone.noTermRemote": "No terminal or editor here: this project is on {host}, another machine.",
	"phone.termFixtures": "Demo data has no terminal.",
	"phone.termOn": "On: opening one still asks for the passkey.",
	"phone.termOld": "This server is older than the terminal.",
	"dev.mac.has": "This Mac unlocks with Touch ID.",
	"dev.phone.has": "This phone unlocks with Face ID.",
	"dev.mac.none": "This Mac has no passkey yet.",
	"dev.phone.none": "This phone has no passkey yet.",
	"dev.mac.enrol": "In a terminal on this Mac: fleet-serve enroll mac",
	"dev.phone.enrol": "On the Mac: fleet-serve enroll <client-id>",
	"dev.mac.enrolBtn": "Enrol this Mac",
	"dev.phone.enrolBtn": "Enrol this phone",
	"phone.offline": "The server is not answering: this is the fleet as it was {ago}.",
	"phone.offlineNever": "The server is not answering.",
	"phone.notServed": "This server does not do that yet.",
	"say.code": "Code omitted.",
	"say.timestamp": "a timestamp",
	"say.id": "an id",
	"say.hex": "a hex id",
	"say.escape": "an escape code",
	"say.commit": "a commit",
	"say.link": "{label} link",
	"say.theLink": "the link",
	"say.line": "line",
	"say.goesOn": "… and it goes on.",
	"phone.noSensor": "No passkey on this device",
	"phone.lockNow": "Lock now",
	"phone.forget": "Forget the passkey",
	"phone.conn.auto": "The server this page came from",
	"phone.conn.fixtures": "Demo data",
	"phone.conn.server": "Another server",
	"phone.about": "ghostfleet · shell {shell} · {mode}",
	"push.probing": "Still finding the server.",
	"push.fixtures": "Demo data has nothing to send a notification.",
	"push.iosTab": "iOS only allows notifications for a home-screen app: Share → Add to Home Screen, then open it from the icon.",
	"push.noApi": "This browser has no notifications.",
	"push.denied": "Notifications are blocked for this app: iOS Settings → Notifications → ghostfleet.",
	"push.notAllowed": "Notifications were not allowed.",
	"push.noKey": "The server has no notification key.",
	"push.noWorker": "The app is not installed far enough to receive notifications: reopen it from the icon.",
	"push.offer": "Turn on notifications, so a session that needs you reaches this phone when the app is closed.",
	"push.turnOn": "Turn on notifications",
	"push.notNow": "Not now",
	"push.onNow": "Notifications are on for this device.",
	"push.unknownThere": "This device is subscribed, but the server does not know it: turn it off and on again.",
	"task.why.page": "the page you are on",
	"task.why.jarvis": "the assistant’s own project",
	"task.why.only": "the only project",
	"task.noProjects": "There is no project to send this to yet.",
	"task.which": "Which project is this for?",
	"task.gone": "That request is no longer on the list.",
	"task.unsent": "I do not know whether it arrived: the page closed while it was sending.",
	"voice.noHear": "This server cannot hear yet.",
	"phone.event.finished": "Finishes working",
	"phone.event.finished.hint": "goes from working to ready",
	"phone.event.finished.verb": "finishes working",
	"phone.event.need-you": "Needs you",
	"phone.event.need-you.hint": "waits for an answer or a permission",
	"phone.event.need-you.verb": "needs you",
	"phone.event.started": "Starts working",
	"phone.event.started.hint": "starts a turn",
	"phone.event.started.verb": "starts working",
	"phone.event.limit": "Runs out of quota",
	"phone.event.limit.hint": "hits the account's usage limit",
	"phone.event.limit.verb": "runs out of quota",
	"phone.event.lost": "Goes down",
	"phone.event.lost.hint": "the machine closed its process",
	"phone.event.lost.verb": "goes down",
	"phone.action.send": "Send a prompt",
	"phone.action.spawn": "Create a session",
	"phone.action.pause": "Pause",
	"phone.action.resume": "Resume",
	"phone.action.wake": "Wake up",
	"phone.action.interrupt": "Interrupt",
	"phone.action.reopen": "Reopen if it went down",
	"phone.action.stop": "Stop",
	"phone.action.check": "Continue only if…",
	"phone.action.notify": "Notify me",
	"phone.action.wait": "Wait",
	"phone.action.summary": "Summarize my day",
	"phone.scope.personal": "Personal",
	"phone.scope.company": "Company's",
	"phone.state.need-you": "needs you",
	"phone.state.working": "working",
	"phone.state.ready": "ready",
	"phone.state.idle": "idle",
	"phone.state.parked": "paused",
	"phone.state.limit": "out of quota",
	"phone.state.interrupted": "interrupted",
	"phone.state.asleep": "asleep",
	"phone.state.lost": "down",
	"phone.day.0": "Sun",
	"phone.day.1": "Mon",
	"phone.day.2": "Tue",
	"phone.day.3": "Wed",
	"phone.day.4": "Thu",
	"phone.day.5": "Fri",
	"phone.day.6": "Sat",
	"phone.auto.unnamed": "Untitled automation",
	"phone.auto.err.event": "unknown event: {event}",
	"phone.auto.err.triggerSession": "invalid session name in the trigger: '{session}'",
	"phone.auto.err.onceDate": "the one-time run needs a date",
	"phone.auto.err.days": "pick at least one day of the week",
	"phone.auto.err.maxSteps": "{n} steps at most",
	"phone.auto.err.action": "step {i}: unknown action '{action}'",
	"phone.auto.err.stepSession": "step {i}: invalid session name '{session}'",
	"phone.auto.err.stepName": "step {i}: the session name can only have letters, numbers, spaces and . _ ~ -",
	"phone.auto.err.missing": "step {i} ({action}): {field} is missing",
	"phone.auto.err.confirm": "step {i}: “{action}” needs you to confirm it",
	"phone.auto.err.eventOnly": "step {i}: “the event’s session” only exists when the trigger is an event",
	"phone.auto.err.noSteps": "add at least one action",
	"phone.auto.field.status": "at least one state",
	"phone.auto.field.project": "the project",
	"phone.auto.field.session": "the session",
	"phone.auto.field.prompt": "the message",
	"phone.auto.field.name": "the name",
	"phone.auto.field.text": "the notice's text",
	"phone.auto.field.minutes": "the minutes",
	"phone.auto.days.all": "every day",
	"phone.auto.days.weekdays": "Monday to Friday",
	"phone.auto.days.weekends": "on weekends",
	"phone.auto.days.list": "on {days}",
	"phone.auto.trig.session": "session {session}",
	"phone.auto.trig.anySession": "any session",
	"phone.auto.trig.anyProject": "any project",
	"phone.auto.trig.event": "When {who} in {project} {what}",
	"phone.auto.trig.once": "Once, on {date} at {at}",
	"phone.auto.trig.every": "Every {every}",
	"phone.auto.trig.days": "{days} at {at}",
	"phone.auto.every.days": "{n} days",
	"phone.auto.every.days.one": "{n} day",
	"phone.auto.step.eventSession": "the event's session",
	"phone.auto.step.send": "Send to {where}: “{prompt}”",
	"phone.auto.step.spawn": "Create session {name} in {project}",
	"phone.auto.step.spawnTask": "Create session {name} in {project} with a task",
	"phone.auto.step.notify": "Notify me: “{text}”",
	"phone.auto.step.wait": "Wait {minutes} min",
	"phone.auto.step.summary": "Send me a summary of what happened today in my projects",
	"phone.auto.step.check": "Continue only if {where} is {states}",
	"phone.auto.or": " or ",
	"phone.tpl.resumen-dia.name": "My day in summary",
	"phone.tpl.resumen-dia.hint": "Every day at a set time, a summary of what happened in your projects: here, and on Telegram if you have it.",
	"phone.tpl.actualizar-pagina.name": "Update a page's data",
	"phone.tpl.actualizar-pagina.hint": "Every week, ask a project's master to update a page's data.",
	"phone.tpl.actualizar-pagina.prompt": "Update the pricing page's data with this week's values, check that it looks right and open a PR.",
	"phone.auto.why.notAdmin": "whoever saved it ({who}) is no longer an admin",
	"phone.auto.why.disabled": "their account is disabled",
	"phone.auto.why.noAccess": "{who} no longer has access to {projects}",
	"phone.auto.why.event": "{where}: {what}",
	"phone.auto.why.manual": "by hand, {who}",
	"phone.auto.notice.paused": "I paused “{name}”: {why}. Once that is fixed, switch it back on.",
	"phone.auto.notice.missed": "“{name}” did not run on {due}: ghostfleet team was off at that time. I did not run it late.",
	"phone.auto.notice.loop": "I switched off “{name}”: it fired {n} times in an hour, which looks like a loop. Check it and switch it back on.",
	"phone.auto.notice.failed": "“{name}” failed at “{step}”: {text}",
	"phone.auto.noDetail": "no detail",
	"phone.auto.run.serverOff": "the server was off at that time",
	"phone.auto.run.refused": "refused: {why}",
	"phone.auto.run.stillRunning": "the previous run had not finished yet",
	"phone.auto.run.running": "it is already running",
	"phone.auto.run.tooMany": "switched off for running too often",
	"phone.auto.step.waited": "waited {minutes} min",
	"phone.auto.step.notified": "notice created",
	"phone.auto.step.noProject": "no project: the step uses the event's and this did not come from an event",
	"phone.auto.step.noSession": "no session: the step uses the event's and this did not come from an event",
	"phone.auto.step.refused": "refused: {who} cannot do that in '{project}'",
	"phone.auto.step.checkGo": "it is {state}: going on",
	"phone.auto.step.checkHalt": "it is {state}: not going on with the steps below",
	"phone.auto.step.noLead": "I could not start the lead",
	"phone.auto.err.notFound": "that automation does not exist",
	"phone.auto.err.companyEdit": "only an admin edits the company's automations",
	"phone.auto.err.othersPersonal": "that automation is someone else's personal one",
	"phone.auto.err.companyCreate": "only an admin creates company automations",
	"phone.auto.err.companyDelete": "only an admin deletes the company's automations",
	"phone.auto.err.cannot": "in '{project}' you cannot “{action}”",
	"phone.auto.err.runNow": "only someone who can edit it can test it by hand",
	"phone.auto.err.runEvent": "it uses “the event’s session”: it can only run when the event happens",
	"phone.auto.ran": "done",
	"phone.auto.failed": "failed",
	"phone.common.saving": "Saving…",
	"phone.nav.automations": "Automations",
	"phone.project.mine": "Mine",
	"phone.vp.delete": "Delete {name}",
	"phone.autos.company": "Company",
	"phone.autos.others": "Others' personal",
	"phone.autos.sub": "A trigger and some actions: at a time, or when something happens to a session.",
	"phone.autos.seen": "Seen them",
	"phone.autos.templates": "Templates",
	"phone.autos.noCompany": "No company automations",
	"phone.autos.noCompanyMine": "No company automations in your projects",
	"phone.autos.companyWhoAdmin": "An admin creates them; whoever has access to their project sees them.",
	"phone.autos.companyWho": "A company admin creates them.",
	"phone.autos.noOthers": "Nobody else has personal automations",
	"phone.autos.none": "You have no automations yet",
	"phone.autos.example": "For example: “Monday to Friday at 10:00, tell the lead of acme-api to go over what is pending”.",
	"phone.autos.createFirst": "Create the first one",
	"phone.autos.runs": "Latest runs",
	"phone.autos.skipped": "skipped: {why}",
	"phone.autos.ran": "“{name}” ran",
	"phone.autos.on": "On",
	"phone.autos.off": "Off",
	"phone.autos.turnOff": "Turn off {name}",
	"phone.autos.turnOn": "Turn on {name}",
	"phone.autos.ownedBy": "{name}'s",
	"phone.autos.paused": "Paused: {why}.",
	"phone.autos.running": "Running now…",
	"phone.autos.next": "Next: {when}",
	"phone.autos.waitingEvent": "Waiting for the event",
	"phone.autos.last": "last {when}",
	"phone.autos.runningBtn": "Running…",
	"phone.autos.tryNow": "Try now",
	"phone.autos.edit": "Edit",
	"phone.autos.view": "View",
	"phone.autos.delTitle": "Delete the automation",
	"phone.autos.delBody.a": "This deletes ",
	"phone.autos.delBody.b": ". What already ran stays in the history.",
	"phone.autos.notFound": "I did not find that automation.",
	"phone.autos.saved": "“{name}” saved",
	"phone.autos.savedOff": "“{name}” saved (off)",
	"phone.autos.namePh": "Automation name",
	"phone.autos.scope": "Scope",
	"phone.autos.scopePersonal": "Personal: just me, with my permissions",
	"phone.autos.scopeCompany": "Company: whoever has its project sees it",
	"phone.autos.roCompany": "It is the company's: only an admin edits it.",
	"phone.autos.roPersonal": "It is {name}'s personal one: it runs with their permissions, so only that person edits it.",
	"phone.autos.editor": "Editor",
	"phone.autos.askAI": "Ask the AI",
	"phone.autos.flow": "Flow",
	"phone.autos.blocks": "Blocks",
	"phone.autos.triggers": "Triggers",
	"phone.autos.schedule": "Schedule",
	"phone.autos.sessionEvent": "Session event",
	"phone.autos.actions": "Actions",
	"phone.autos.dragHint": "Drag it into the flow, or tap it to add it at the end",
	"phone.autos.dragHelp": "Drag a block into the flow, or tap it to add it at the end.",
	"phone.autos.dropEmpty": "Drag an action here from the left (or tap it)",
	"phone.autos.dropLast": "drop here to add at the end",
	"phone.autos.when": "When",
	"phone.autos.event": "Event",
	"phone.autos.someDays": "Some days",
	"phone.autos.once": "Once",
	"phone.autos.everySoOften": "Every so often",
	"phone.autos.days": "Days",
	"phone.autos.date": "Date",
	"phone.autos.time": "Time",
	"phone.autos.every": "Every",
	"phone.autos.whenSession": "When a session…",
	"phone.autos.whichProject": "Which project",
	"phone.autos.anyProject": "Any project",
	"phone.autos.whichSession": "Which session",
	"phone.autos.any": "Any",
	"phone.autos.cooldown": "Do not repeat with the same session before (min)",
	"phone.autos.dragMove": "Drag to move",
	"phone.autos.up": "Move up",
	"phone.autos.down": "Move down",
	"phone.autos.removeStep": "Remove step",
	"phone.autos.project": "Project",
	"phone.autos.choose": "Choose…",
	"phone.autos.eventProject": "The event's",
	"phone.autos.session": "Session",
	"phone.autos.newName": "Name of the new session",
	"phone.autos.firstTask": "First task (optional)",
	"phone.autos.resumeMsg": "Message on resume (optional)",
	"phone.autos.vars": "You can use {fecha}, {hora}, {proyecto}, {sesion}",
	"phone.autos.branchOpt": "Branch (optional)",
	"phone.autos.noticeText": "Notice text",
	"phone.autos.noticePh": "{sesion} finished in {proyecto}",
	"phone.autos.ifNow": "…if it is now",
	"phone.autos.states": "States",
	"phone.autos.checkHint": "If it is not, the automation ends here (it does not count as an error).",
	"phone.autos.summaryHint": "What happened today in the projects of whoever runs the automation: who did what, what is still working and who needs you. It arrives as a notice here, and on Telegram too if you are the one with fleet-telegram on this machine.",
	"phone.autos.minutes": "Minutes (1 to 60)",
	"phone.autos.confirmStop": "I confirm this automation may stop the session (the worktree is left free, not deleted)",
	"phone.autos.aiFailed": "I could not: {why}",
	"phone.autos.aiHint": "Tell it what you want in one sentence, for example: “every day at 9, wake the workers of acme-web and tell the lead to hand out what is pending”. It builds the blocks and you check them before saving.",
	"phone.autos.aiApplied": "I put it in the editor",
	"phone.autos.undo": "undo",
	"phone.autos.aiBusy": "Building it…",
	"phone.autos.aiPh": "What do you want to automate?",
	"phone.search": "Search",
	"phone.searchHint": "Find a project or session",
	"phone.projects": "Projects",
	"phone.sessions": "Sessions",
	"phone.noMatches": "No matches",
	"phone.held": "Held items",
	"phone.openHeld": "Open the input box",
	"phone.heldHint": "A wake is waiting for an empty input box. Open the session to send or clear its text.",
	"phone.nothingWaiting": "Nothing is waiting on you",
	"phone.signIns": "Pending sign-ins",
	"phone.noSignIns": "No sign-in is waiting for you",
	"phone.loginStarted": "Sign-in ready",
	"phone.loginStartFailed": "Could not start sign-in",
	"phone.loginDone": "Sign-in complete",
	"phone.loginFailed": "Could not finish sign-in. Check the session and try again.",
	"phone.loginReadFailed": "Could not read sign-ins",
	"phone.thisHost": "This host",
	"phone.firstSite": "First time for this site — check the provider before opening",
	"phone.signIn": "Sign in",
	"phone.openConnector": "Open connector settings",
	"phone.open": "Open",
	"phone.code": "Claude sign-in code",
	"phone.callback": "Full redirect URL",
	"phone.finishLogin": "Finish — confirm sign-in",
	"phone.expires": "Expires in {time}",
	"phone.expired": "Expired",
	"phone.queue": "Queue",
	"phone.reply": "Reply",
	"phone.replyHint": "Sent to the lead quoting this item. It leaves the list when the lead closes it.",
	"phone.stacks": "Session stacks",
	"phone.openStack": "Open stack · {n}",
	"phone.noSessions": "No sessions to choose",
	"phone.editStack": "Choose sessions",
	"phone.emptyStack": "Choose sessions to build a stack",
	"phone.openSession": "Open session",
	"phone.reviews": "Reviews",
	"phone.review": "Review",
	"phone.reviewsOff": "Reviews are switched off",
	"phone.noBranch": "No branch",
	"phone.video": "Video",
	"phone.stills": "Images",
	"phone.steps": "{n} steps",
	"phone.earlier": "{n} earlier runs",
	"phone.noReviews": "No recorded runs yet",
	"phone.hostMissing": "{host} did not answer",
	"phone.saved": "Saved",
	"phone.saveFailed": "Could not save",
	"phone.saving": "Saving…",
	"phone.retry": "Try again",
	"phone.approve": "Approve",
	"phone.reject": "Reject",
	"phone.reviewNote": "Review note",
	"phone.restOk": "Mark remaining steps OK",
	"phone.chapter": "Go to chapter",
	"phone.ok": "OK",
	"phone.problem": "Problem",
	"phone.skip": "Skip",
	"phone.requests": "Requests · {n}",
	"phone.autoNameExample": "review-{fecha}",
	"phone.event.interrupted": "Interrupted",
	"phone.event.interrupted.hint": "A turn was interrupted",
	"phone.event.interrupted.verb": "is interrupted",
	"phone.state.starting": "starting",
	"phone.state.unknown": "unknown",
	"phone.approved": "Approved — the review check passes",
	"phone.rejected": "Rejected — changes are needed",
	"phone.unreviewed": "Not reviewed — mark each step or review the recording",
	"phone.changesNeeded": "Some steps need changes",
	"phone.reasonNeeded": "Flagged steps need a written reason",
	"phone.queueState.waiting": "Waiting",
	"phone.queueState.replied": "Replied",
	"phone.cardHeld": "Held",
	"phone.signInFailed": "Sign-in failed",
	"phone.stackPlace": "Stacks",
	"phone.autoReadOnly": "This automation is read-only.",
	"phone.steps.one": "{n} step",
	"phone.earlier.one": "{n} earlier run",
	"phone.requests.one": "Request · {n}",
	"phone.auto.err.maxSteps.one": "{n} step at most",
	"phone.auto.notice.loop.one": "I switched off “{name}”: it fired {n} time in an hour, which looks like a loop. Check it and switch it back on."
};
//#endregion
//#region web/ui/words/es.js
var es_default = {
	"sched.default": "continúa",
	"status.need-you": "Te necesita",
	"status.need-you.hint": "Está esperando una respuesta o un permiso",
	"status.working": "Trabajando",
	"status.working.hint": "Claude está en medio de un turno",
	"status.ready": "Lista",
	"status.ready.hint": "Terminó su turno, revisa lo que hizo",
	"status.parked": "En pausa",
	"status.parked.hint": "Pausada a propósito, no gasta cupo",
	"status.idle": "Inactiva",
	"status.idle.hint": "Abierta, sin tarea",
	"status.starting": "Arrancando",
	"status.starting.hint": "Se está abriendo",
	"status.limit": "Sin cupo",
	"status.limit.hint": "Llegó al límite de uso de la cuenta",
	"status.interrupted": "Interrumpida",
	"status.interrupted.hint": "Su turno se cortó",
	"status.unknown": "Sin datos",
	"status.unknown.hint": "No se pudo leer su estado",
	"status.asleep": "Dormida",
	"status.asleep.hint": "Hibernada; se despierta con un clic",
	"status.lost": "Perdida",
	"status.lost.hint": "La máquina cerró su proceso; se puede reabrir",
	"ago.now": "ahora",
	"ago.min": "hace {n} min",
	"ago.h": "hace {n} h",
	"ago.d": "hace {n} d",
	"common.ok": "Listo",
	"common.close": "Cerrar",
	"common.cancel": "Cancelar",
	"common.wait": "Un momento…",
	"common.loading": "Cargando…",
	"common.save": "Guardar",
	"ui.typeTo.a": "Escribe ",
	"ui.typeTo.b": " para confirmar",
	"nav.label": "Navegación",
	"nav.home": "Inicio",
	"nav.map": "Mapa en vivo",
	"nav.projects": "Proyectos",
	"nav.search": "Buscar…",
	"nav.searchProject": "Buscar proyecto",
	"nav.menu": "Menú",
	"auth.name": "Nombre",
	"light.work": "Trabajando",
	"light.start": "Arrancando",
	"light.wait": "Te necesita",
	"light.error": "Con problemas",
	"light.done": "Lista",
	"light.idle": "Abierta",
	"light.off": "Dormida",
	"common.lead": "líder",
	"map.opened": "{project}: se abrió {session}",
	"map.closed": "{project}: se cerró {session}",
	"map.sub": "Toda la flota a la vez. El barco fantasma va a donde está pasando algo.",
	"map.showIdle": "Mostrar proyectos sin sesiones ({n})",
	"map.reading": "Leyendo la flota…",
	"map.none": "No hay sesiones abiertas en ningún proyecto.",
	"map.noSessions": "sin sesiones",
	"map.live": "En vivo",
	"map.waiting": "Esperando movimiento en la flota… aquí aparece cada sesión que se abre, termina o te necesita.",
	"look.need": "Te necesita",
	"look.work": "Trabajando",
	"look.fresh": "Recién terminó",
	"look.warn": "Sin cupo / cortada",
	"look.open": "Abierta",
	"look.off": "Inactiva",
	"tip.agent": "Agente",
	"tip.owner": "Responsable",
	"tip.label": "Etiqueta",
	"tip.moved": "Se movió",
	"tip.said": "Dijo",
	"board.open": "Abrir {name}",
	"board.none": "Ninguna flota está trabajando ahora.",
	"board.quiet": "{n} quietas",
	"group.need.title": "Te necesitan",
	"group.need.hint": "Esperan una respuesta o un permiso",
	"group.work.title": "Trabajando",
	"group.work.hint": "En medio de un turno",
	"group.ready.title": "Listas para revisar",
	"group.ready.hint": "Terminaron su turno",
	"group.rest.title": "En pausa o inactivas",
	"group.rest.hint": "No están gastando cupo",
	"project.branch": "Rama",
	"project.queued": "{n} en cola",
	"project.rmTitle": "Borrar worktree libre",
	"project.rmAction": "Borrar worktree",
	"project.rmBody.a": "Se borra la carpeta ",
	"project.rmBody.b": " (rama ",
	"project.rmBody.c": "). ghostfleet se niega si tiene cambios sin guardar o sin subir, y te dice por qué.",
	"project.rmDone": "Worktree borrado",
	"project.leadReady": "El líder ya está listo.",
	"project.leadWasOpen": "El líder ya estaba abierto.",
	"project.leadFailed": "No se pudo arrancar el líder: {why}",
	"project.sessions": "{n} sesiones",
	"project.freeWts": "{n} worktrees libres",
	"project.leadIs": "El líder es el Claude del proyecto que reparte el trabajo",
	"project.leadStart": "Arrancar el líder",
	"project.leadReopen": "Reabrir el líder",
	"project.leadWake": "Despertar al líder",
	"project.leadResume": "Reanudar al líder",
	"project.newSession": "Nueva sesión",
	"project.new": "Nueva",
	"project.readFailed": "No se pudo leer la flota de {project}: {why}",
	"project.empty": "No hay sesiones abiertas en este proyecto.",
	"project.emptyWhy": "Una sesión es un Claude trabajando en su propio worktree, con su propia rama. Así dos personas avanzan en paralelo sin pisarse.",
	"project.openFirst": "Abrir la primera",
	"project.tree": "Árbol del proyecto",
	"project.treeHint": "El líder en la carpeta principal y cada sesión en su propio worktree (sus “hijos”)",
	"project.noLead": "Sin líder abierto en la carpeta principal.",
	"project.free": "libre",
	"project.openHere": "Abrir una sesión aquí",
	"common.delete": "Borrar",
	"project.created": "Sesión creada",
	"project.newWhy": "Se crea un worktree con su propia rama y se abre un Claude ahí. Así cada persona trabaja en paralelo sin pisar el trabajo del otro.",
	"project.namePh": "Ej. login-con-google",
	"project.willBe": "Se va a llamar",
	"project.what": "¿Qué tiene que hacer?",
	"project.whatPh": "Describe la tarea completa: qué construir, dónde y cómo saber que está lista. Lo puedes dejar vacío y escribirle después.",
	"project.where": "Dónde",
	"project.newWt": "Worktree nuevo",
	"project.reuse": "Reusar {name} ({branch})",
	"project.advanced": "Opciones avanzadas",
	"project.sameAsName": "igual al nombre",
	"project.from": "Partir de",
	"project.fromPh": "rama base del repo",
	"project.model": "Modelo",
	"project.accountModel": "El de la cuenta",
	"common.creating": "Creando…",
	"project.create": "Crear sesión",
	"sess.opt.yesAlways": "Sí, y no volver a preguntar",
	"sess.opt.yesEdits": "Sí, permitir todas las ediciones de esta sesión",
	"sess.opt.yes": "Sí, permitir",
	"sess.opt.no": "No, decirle otra cosa",
	"sess.asksPermission": "Claude pide permiso",
	"sess.aTool": "una herramienta",
	"sess.checkCmd": "Revisa el comando antes de permitirlo: corre en el worktree de esta sesión, con tu cuenta.",
	"sess.asks": "Claude te pregunta",
	"sess.qOf": "pregunta {i} de {n}",
	"sess.review": "revisar y enviar",
	"sess.yourAnswer": "Escribe tu respuesta",
	"common.send": "Enviar",
	"sess.readingTerm": "Leyendo la terminal…",
	"sess.older": "Cargar mensajes anteriores",
	"sess.noMsgs": "Todavía no hay mensajes en esta sesión.",
	"sess.actions": "{n} acciones",
	"sess.instruction": "Instrucción",
	"sess.queuedMsg": "En cola · se entrega cuando termine el turno",
	"sched.in30": "En 30 min",
	"sched.in1h": "En 1 hora",
	"sched.in3h": "En 3 horas",
	"sched.tomorrow": "Mañana 9:00",
	"sched.title": "Programar un mensaje para {name}",
	"sched.why": "A la hora que elijas, ghostfleet le escribe este mensaje a la sesión, aunque nadie esté mirando. Sirve para retomar después del límite de uso o dejar algo para mañana.",
	"sched.message": "Mensaje",
	"sched.exact": "…o a una hora exacta",
	"sched.go": "Programar",
	"sess.queuedQ": "Quedó en cola: la sesión tiene una pregunta pendiente. Respóndela primero.",
	"sess.queuedTurn": "Quedó en cola: se entrega cuando termine el turno actual.",
	"sess.changed": "El pedido cambió mientras lo mirabas; no se envió nada. Revisa de nuevo.",
	"sess.maxFiles": "Hasta {n} archivos por mensaje.",
	"sess.pasted": "imagen pegada",
	"sess.attaching": "Te adjunto estos archivos.",
	"sess.filesLost": "{n} archivos de este borrador no sobrevivieron a la recarga. Vuelve a adjuntarlos.",
	"sess.filesLost.one": "Un archivo de este borrador no sobrevivió a la recarga. Vuelve a adjuntarlo.",
	"sess.attached": "Archivos adjuntos (ábrelos desde estas rutas)",
	"sess.stopRmTitle": "Detener y borrar el worktree",
	"sess.stopTitle": "Detener la sesión",
	"sess.stopRm": "Detener y borrar",
	"sess.stop": "Detener",
	"sess.stopRmBody.a": "Se cierra ",
	"sess.stopRmBody.b": " y se borra su worktree. ghostfleet solo lo borra si no hay cambios sin guardar y la rama está subida o mergeada; si no, la detiene igual y deja la carpeta, diciendo por qué.",
	"sess.stopBody.b": " para siempre. Su worktree y su rama quedan como están, y la conversación se conserva.",
	"sess.stopped": "Detenida",
	"common.back": "Volver",
	"common.backTo": "Volver a {place}",
	"sess.changeLabel": "Cambiar etiqueta",
	"sess.schedMsg": "Mensaje programado: {msg}",
	"sess.unsched": "Cancelar programación",
	"sess.interruptHint": "Corta el turno actual, como apretar Esc",
	"sess.interrupt": "Interrumpir",
	"sess.wake": "Despertar",
	"sess.reopen": "Reabrir",
	"sess.resume": "Reanudar",
	"sess.pause": "Pausar",
	"sess.more": "Más",
	"sess.setLabel": "Ponerle etiqueta…",
	"sess.schedule": "Programar un mensaje…",
	"sess.renameMenu": "Renombrar…",
	"sess.stopMenu": "Detener sesión…",
	"sess.stopRmMenu": "Detener y borrar worktree…",
	"sess.quotaBack": "el cupo vuelve {when}",
	"sess.limitWhy": "Mientras tanto no puede seguir. Puedes dejarlo programado para que retome solo.",
	"sess.alreadySched": "Ya está programado para {when}.",
	"sess.continueMsg": "continúa con la tarea donde la dejaste",
	"sess.resumeOnQuota": "Retomar solo cuando vuelva el cupo",
	"sess.otherTime": "Elegir otra hora…",
	"sess.chat": "Chat",
	"sess.screen": "Pantalla",
	"sess.screenHint": "Solo lectura: lo que muestra ahora la terminal del propio agente",
	"term.tab.term": "Terminal",
	"term.tab.edit": "Editor",
	"term.tab.sessions": "Sesiones",
	"term.cap.term": "La terminal propia de {project}, la misma pestaña desde cada sesión",
	"term.cap.edit": "El editor propio de {project}, la misma pestaña desde cada sesión",
	"term.opening": "abriendo…",
	"term.leave.term": "Salir de la terminal",
	"term.leave.edit": "Salir del editor",
	"term.enter.term": "Escribir en la terminal",
	"term.enter.edit": "Escribir en el editor",
	"term.smaller": "Texto más pequeño",
	"term.larger": "Texto más grande",
	"term.keyboard": "Teclado",
	"term.copied": "Copiado",
	"term.reconnect": "Reconectar",
	"term.openAgain": "Abrir de nuevo",
	"term.idle": "Cerrada tras {min} min sin uso",
	"term.idleWhy": "No se pierde nada: la pestaña sigue abierta y Reconectar la retoma donde estaba.",
	"term.takeover.term": "Abierta en otra pestaña",
	"term.takeover.edit": "Abierto en otra pestaña",
	"term.takeoverWhy": "Solo una ventana a la vez escribe aquí, y otra tuya acaba de abrir esta pestaña.",
	"term.failed": "No se pudo conectar",
	"term.dropped": "Se cortó la conexión",
	"term.ended.term": "La shell terminó",
	"term.ended.edit": "El editor se cerró",
	"term.failedWhy": "El servidor no aceptó la conexión. Abrir de nuevo lo intenta otra vez.",
	"term.droppedWhy": "La pestaña sigue corriendo en el servidor, y Abrir de nuevo la retoma.",
	"term.endedWhy": "Abrir de nuevo abre una nueva en la carpeta del proyecto.",
	"term.noEditor": "No hay editor en esta máquina",
	"term.password": "Primero cambia tu contraseña",
	"term.passwordWhy": "Tu cuenta todavía tiene una contraseña temporal, y esta pestaña se abre cuando la cambies.",
	"term.changePassword": "Cambiar contraseña",
	"term.signedOut": "Tu sesión se cerró",
	"term.signedOutWhy": "El inicio de sesión en este navegador terminó.",
	"term.signIn": "Iniciar sesión",
	"term.refused": "El servidor rechazó la conexión",
	"term.off": "La terminal está desactivada en este dispositivo",
	"term.offWhy": "Se activa en Ajustes. Pide la llave de acceso, y el servidor registra qué dispositivo lo hizo.",
	"term.openSettings": "Ajustes",
	"sess.readFailed": "No se pudo leer la conversación: {why}",
	"chat.slowDown": "el servidor pidió a este dispositivo que espere",
	"chat.offline": "el servidor no responde",
	"chat.noAnswer": "el servidor todavía no responde",
	"chat.loadFailed": "No se pudo cargar la conversación — {why} · reintentando",
	"chat.olderLoading": "Cargando mensajes anteriores…",
	"chat.olderFailed": "Los mensajes anteriores no se cargaron — {why}",
	"chat.start": "Inicio de la conversación",
	"acct.workers.paused": "trabajadores en pausa",
	"acct.workers.running": "los trabajadores siguen (sin tope de presupuesto)",
	"acct.workers.mixed": "trabajadores en pausa, salvo donde no hay tope de presupuesto",
	"acct.until": " hasta {at}",
	"acct.resets": "{label} {pct}% (se renueva {at}, leído {read})",
	"acct.off": "las cuentas están desactivadas",
	"acct.none": "cuentas: ningún perfil tiene cuenta todavía",
	"acct.exhausted": "todas las cuentas agotadas{until} — {workers}",
	"acct.unsaved": "con un inicio de sesión no guardado — cambio automático en pausa",
	"acct.noActive": "ninguna cuenta está activa",
	"acct.read": "leído {when}",
	"acct.never": "nunca",
	"acct.open": "Cuentas de Claude: ver todas las cuentas",
	"acct.title": "Cuentas de Claude",
	"acct.threshold": "cambia al {pct}% del límite de 5h o de 7d, gastando primero la semana que termina antes",
	"acct.noProfile": "ningún perfil tiene cuenta todavía — fleet-accounts add <perfil> <nombre>",
	"acct.profUnsaved": " — CON UN INICIO DE SESIÓN NO GUARDADO, cambio automático en pausa (fleet-accounts add para manejarlo)",
	"acct.profExhausted": " — TODAS AGOTADAS{until}, {workers}",
	"acct.noAccounts": "(sin cuentas)",
	"acct.one": "una sola cuenta: todavía no hay a cuál cambiar — agrega otra",
	"acct.pin": "en '{account}' a mano hasta {at} — el planificador la deja ahí salvo que se agote",
	"acct.readOnly": "solo lectura — la cuenta se cambia en la computadora: fleet-accounts use <perfil> <nombre>",
	"acct.activeTag": " (activa)",
	"sess.uploading": "subiendo…",
	"sess.notUploaded": "no se subió",
	"sess.remove": "Quitar {name}",
	"sess.attach": "Adjuntar archivos o imágenes",
	"sess.drop": "Suelta aquí los archivos…",
	"sess.pendingAbove": "Tiene un pedido pendiente arriba; lo que escribas queda en cola hasta responderlo.",
	"sess.writeTo": "Escríbele a {name}…  (adjunta o arrastra un archivo · Enter envía)",
	"sess.uploadingBtn": "Subiendo…",
	"sess.labelTitle": "Etiqueta de la sesión",
	"sess.labelWhy": "Una nota corta para reconocerla de un vistazo, como “urgente cliente” o “esperando revisión”. Se ve en la tarjeta y en la terminal. Vacía la quita.",
	"sess.labelField": "Etiqueta (hasta 40 caracteres)",
	"sess.renameTitle": "Renombrar sesión",
	"sess.newName": "Nombre nuevo",
	"sess.rename": "Renombrar",
	"keys.jump.first": "saltar → ¿proyecto? 1-9  ·  s + número = sus sesiones  ·  p = inicio  ·  esc",
	"keys.jump.proj": "saltar → proyecto {n}: ¿sesión? 1-9  ·  ⏎ o m = líder  ·  s = sus sesiones  ·  esc",
	"keys.jump.grid": "saltar → ¿sesiones de qué proyecto? 1-9  ·  esc",
	"task.missed": "No llegó a {project}.",
	"nav.automations": "Automatizaciones",
	"nav.activity": "Actividad",
	"nav.settings": "Ajustes",
	"as.open": "Abrir el asistente de voz",
	"as.name": "Asistente",
	"settings.language": "Idioma",
	"verb.fleet_send": "le escribió a",
	"verb.attach": "adjuntó un archivo a",
	"verb.fleet_answer": "respondió un pedido de",
	"verb.fleet_interrupt": "interrumpió a",
	"verb.fleet_pause": "pausó",
	"verb.fleet_resume": "reanudó",
	"verb.fleet_wake": "despertó",
	"verb.fleet_reopen": "reabrió",
	"verb.fleet_spawn": "creó la sesión",
	"verb.fleet_stop": "detuvo",
	"verb.fleet_rename": "renombró",
	"verb.fleet_worktree_remove": "borró el worktree",
	"verb.fleet_unqueue": "sacó de la cola un mensaje de",
	"verb.assign": "cambió el responsable de",
	"verb.login": "entró",
	"verb.setup": "creó las cuentas",
	"verb.add_user": "agregó a",
	"verb.password": "cambió su contraseña",
	"verb.auto_save": "guardó la automatización",
	"verb.auto_delete": "borró la automatización",
	"verb.route": "el asistente decidió sobre",
	"verb.voice_install": "descargó la voz",
	"verb.voice_delete": "borró la voz",
	"result.ran": "hecho",
	"result.refused": "rechazado",
	"result.changed": "el pedido cambió",
	"activity.title": "Actividad",
	"activity.sub": "Todo lo que se hizo desde la web, con nombre y hora.",
	"activity.empty": "Todavía no hay actividad.",
	"settings.title": "Ajustes",
	"settings.languageHint": "La app y el asistente te hablan en este idioma, en cualquier dispositivo.",
	"settings.you": "tú",
	"settings.connection": "Conexión",
	"settings.demoReset": "Demo reiniciado",
	"settings.resetDemo": "Reiniciar datos del demo",
	"project.filter": "Filtrar por responsable",
	"common.and": " y ",
	"task.state.ask": "¿A dónde va?",
	"task.state.failed": "No llegó",
	"task.state.need-you": "Te necesita",
	"task.state.replied": "Respondió",
	"task.state.working": "Trabajando",
	"task.state.sent": "Enviada",
	"task.state.sending": "Mandando…",
	"task.other": "otro…",
	"task.tickAria": "Marcar como lista: {title}",
	"task.tick": "Ya está, sacarla de la lista",
	"task.title": "Pedidos",
	"task.clear": "Quitar respondidas",
	"task.hide": "Ocultar pedidos",
	"task.deciding": "Viendo a dónde va…",
	"task.see": "Ver pedidos: {n}",
	"ship.listening": "Te escucho…",
	"ship.hearing": "Transcribiendo…",
	"ship.routing": "Viendo a dónde va…",
	"ship.sending": "Enviando…",
	"ship.starting": "Despertando al líder…",
	"ship.thinking": "Pensando…",
	"ship.acting": "Trabajando",
	"ship.speaking": "Hablando",
	"ship.idle": "Listo",
	"ship.off": "Sin líder abierto",
	"as.doneTalking": "Terminar de hablar",
	"as.talk": "Hablar",
	"as.listenManual": "Te escucho — toca cuando termines",
	"as.listenAuto": "Te escucho — habla tranquilo",
	"as.stopAll": "Detener todo",
	"as.typeBig": "Escríbele: “vamos a acme-web, revisa los tests de pagos”…",
	"as.type": "…o escríbele aquí",
	"as.voiceOpts": "Opciones de voz",
	"as.vsChecking": "Revisando la voz…",
	"as.vsLocal": "Voz local: se transcribe en esta máquina, el audio no sale de aquí.",
	"as.vsBrowser": "Voz del navegador (Chrome la procesa en sus servidores).",
	"as.vsNone": "Este navegador no trae dictado y no hay voz local instalada: escríbele.",
	"as.hintManual": "No te corto aunque hagas pausas. Toca ✓ cuando termines.",
	"as.hintAuto": "Puedes pausar para pensar: envío cuando calles {s} segundos, o toca ✓.",
	"as.sLong": "4,5",
	"as.sShort": "2,5",
	"as.whenPause": "Cuando hago una pausa:",
	"as.voiceOut": "Responder en voz alta",
	"as.handsFree": "Conversación (vuelve a escucharte después de responder)",
	"as.follow": "Llevarme a la sesión donde está trabajando",
	"as.question": "pregunta",
	"as.live": "en vivo",
	"as.in": "en {where}",
	"as.laneEmpty": "Sin sesiones abiertas: al pedirle algo arranco su líder.",
	"as.hint.title": "Háblale como a un compañero.",
	"as.hint.examples": "“Vamos a acme-api” · “En billing-svc revisa los tests de facturas” · “Abre la sesión payments” · “Muéstrame el mapa”.",
	"as.hint.how": "Todo pasa primero por quien reparte: mira la conversación y decide un solo destino. Si no está seguro, te pregunta antes de mandar.",
	"as.sub": "decide a dónde va cada cosa y, si duda, te pregunta",
	"as.pickVoice": "Elegir voz",
	"as.close": "Cerrar asistente",
	"as.talkingTo": "Hablas con",
	"as.auto": "Automático",
	"as.leadOf": "líder de {project}",
	"as.leadLater": "líder de {project} (aún sin abrir)",
	"as.today": "¿Qué hacemos hoy?",
	"as.proposals": "Esperan tu sí",
	"as.proposal": "Jarvis pregunta: {summary}?",
	"as.proposalGranted": "Sí dado: {summary}",
	"as.proposalYes": "Sí",
	"as.proposalNo": "No",
	"as.proposalYesDone": "Sí. Jarvis va a: {summary}.",
	"as.proposalNoDone": "No. Jarvis no va a: {summary}.",
	"as.conversing": "en conversación",
	"as.done": "Ya terminé",
	"pause.normal": "Espero una pausa de 2,5 s y envío",
	"pause.larga": "Espero una pausa larga (4,5 s), para pensar",
	"pause.manual": "No corto solo: espero a que toques «Ya terminé»",
	"voice.micDenied": "El navegador no dio permiso al micrófono. Actívalo en el candado de la barra de direcciones.",
	"voice.micDeniedShort": "El navegador no dio permiso al micrófono.",
	"voice.transcribeFailed": "No se pudo transcribir: {why}",
	"voice.needsNet": "El dictado del navegador necesita internet.",
	"voice.dictation": "Dictado: {why}",
	"voice.code": "(código)",
	"agent.frame.voice": "{name}, por voz desde {app}.",
	"agent.frame.typed": "{name}, por el asistente desde {app}.",
	"agent.frame.ask": "Responde breve y en español (se lee en voz alta). Si la tarea es grande, repártela en sesiones nuevas (fleet_spawn) y dime qué abriste.",
	"agent.heardNothing": "No escuché nada, dejo de escuchar. Toca Hablar para seguir.",
	"agent.passed": "Listo, se lo pasé {who}.",
	"agent.missed": "No llegó: {why}",
	"agent.dupe": "Eso ya lo recibí, no lo mando dos veces.",
	"agent.routeFailed": "No pude decidir a dónde va “{text}”: {why}. Dímelo de nuevo.",
	"agent.routeFailedSay": "No pude decidir a dónde va. Dímelo de nuevo.",
	"agent.here": "Listo, estamos en {project}. ¿Qué hacemos?",
	"agent.noted": "Listo, anoté {n}: {list}.",
	"agent.unsure": "Y {n} no sé a dónde van: están en la lista.",
	"agent.toSession": "a {session}, en {project}",
	"agent.toLead": "al líder de {project}",
	"agent.going": "Va {who}.",
	"agent.goingWhy": "Va {who}: {why}",
	"agent.leadStarted": "Arranqué el líder de {project}.",
	"agent.leadWoke": "Desperté al líder de {project}.",
	"agent.leadFailed": "No pude arrancar el líder de {project}: {why}",
	"agent.earlier": "Lo que dije antes: {earlier}",
	"agent.queuedQ": "Quedó en cola: el líder tiene una pregunta pendiente.",
	"agent.queuedTurn": "Quedó en cola: el líder termina su turno y lo toma.",
	"agent.missedAt": "No llegó a {project}: {why}",
	"agent.from": "De {project}.",
	"agent.fromAbout": "De {project}, sobre {title}.",
	"agent.opened": "Abrió la sesión {name}",
	"agent.leadIs": "El líder está {word}",
	"cmd.map": "Abro el mapa en vivo.",
	"cmd.home": "Vamos al inicio.",
	"cmd.activity": "Abro la actividad.",
	"cmd.open": "Abro {session}.",
	"cmd.openIn": "Abro {session} en {project}.",
	"cmd.noSession": "No encontré una sesión parecida a “{name}”.",
	"vp.hello": "Hola, así sueno cuando te respondo. ¿Qué hacemos hoy?",
	"vp.loading": "Cargando voces…",
	"vp.title": "Voz que te responde",
	"vp.listen": "Escuchar a {name}",
	"vp.delete": "Borrar a {name}",
	"vp.online": "De internet: escúchala y, si te gusta, descárgala",
	"vp.onlineView": "De internet: escucha una muestra; un admin puede descargarla",
	"vp.quality": "calidad {q}",
	"vp.preparing": "Preparando…",
	"vp.download": "Descargar",
	"vp.failed": "No se pudo descargar {name}: {why}",
	"agent.noServer": "El asistente todavía no está conectado a un servidor.",
	"agent.you": "El propietario",
	"app.notHere": "Este servidor no tiene esta página.",
	"settings.reading": "Leyendo…",
	"settings.hosts": "Máquinas emparejadas",
	"settings.hostsNone": "Ninguna otra máquina está emparejada con esta.",
	"settings.hostThis": "esta máquina",
	"settings.hostOnline": "responde",
	"settings.hostOffline": "no responde",
	"settings.unpaired": "{name} ya no está emparejada.",
	"settings.unpair": "Desemparejar",
	"settings.unpairQ": "Desemparejar…",
	"settings.backend": "Hablar con",
	"settings.device": "Este dispositivo",
	"settings.push": "Notificaciones",
	"settings.pushLabel": "Avisar a este dispositivo cuando una sesión te necesite",
	"settings.terminal": "Terminal y editor",
	"settings.terminalLabel": "Permitir terminal y editor desde este dispositivo",
	"settings.about": "Acerca de",
	"settings.serverUrl": "Dirección del servidor",
	"settings.useServer": "Usar este servidor",
	"lock.tagline": "tu flota, en el bolsillo",
	"lock.noPasskey": "Esto necesita una llave de acceso: {why}",
	"lock.enrolHint": "registra una primero en la pantalla de bloqueo",
	"lock.unavailable": "Este dispositivo no tiene llave de acceso: {why}",
	"lock.fixturesGate": "Datos de demostración: nada de esto llega a una máquina real.",
	"lock.asking": "Preguntando a {where} si hay una ventana de registro abierta…",
	"lock.askFailed": "No se pudo preguntar si el registro está abierto: {why}",
	"lock.windowOpen": "Hay una ventana de registro abierta para {client}.",
	"lock.windowClosed": "{how}: imprime un código de un solo uso, válido por 15 minutos. No importan las mayúsculas ni el guion.",
	"lock.code": "Código de un solo uso",
	"lock.register": "Registrar una llave de acceso",
	"lock.unlocking": "Desbloqueando…",
	"lock.unlock": "Desbloquear con {sensor}",
	"lock.bypass": "Seguir sin llave de acceso",
	"lock.lookAgain": "Buscar el servidor otra vez",
	"lock.where": "¿Qué servidor?",
	"phone.noLead": "{project} no tiene un líder que se pueda iniciar desde este teléfono.",
	"phone.noTermRemote": "Sin terminal ni editor aquí: este proyecto está en {host}, otra máquina.",
	"phone.termFixtures": "Los datos de demostración no tienen terminal.",
	"phone.termOn": "Activado: abrir uno igual pide la llave de acceso.",
	"phone.termOld": "Este servidor es anterior a la terminal.",
	"dev.mac.has": "Esta Mac se desbloquea con Touch ID.",
	"dev.phone.has": "Este teléfono se desbloquea con Face ID.",
	"dev.mac.none": "Esta Mac todavía no tiene llave de acceso.",
	"dev.phone.none": "Este teléfono todavía no tiene llave de acceso.",
	"dev.mac.enrol": "En una terminal de esta Mac: fleet-serve enroll mac",
	"dev.phone.enrol": "En la Mac: fleet-serve enroll <client-id>",
	"dev.mac.enrolBtn": "Registrar esta Mac",
	"dev.phone.enrolBtn": "Registrar este teléfono",
	"phone.offline": "El servidor no responde: esta es la flota como estaba {ago}.",
	"phone.offlineNever": "El servidor no responde.",
	"phone.notServed": "Este servidor todavía no hace eso.",
	"say.code": "Código omitido.",
	"say.timestamp": "una fecha",
	"say.id": "un identificador",
	"say.hex": "un identificador hexadecimal",
	"say.escape": "un código de escape",
	"say.commit": "un commit",
	"say.link": "enlace {label}",
	"say.theLink": "el enlace",
	"say.line": "línea",
	"say.goesOn": "… y sigue.",
	"phone.noSensor": "Este dispositivo no tiene llave de acceso",
	"phone.lockNow": "Bloquear ahora",
	"phone.forget": "Olvidar la llave de acceso",
	"phone.conn.auto": "El servidor de esta página",
	"phone.conn.fixtures": "Datos de demostración",
	"phone.conn.server": "Otro servidor",
	"phone.about": "ghostfleet · versión {shell} · {mode}",
	"push.probing": "Todavía buscando el servidor.",
	"push.fixtures": "Los datos de demostración no tienen nada que avisar.",
	"push.iosTab": "iOS solo permite avisos para una app en la pantalla de inicio: Compartir → Agregar a inicio, y ábrela desde el ícono.",
	"push.noApi": "Este navegador no tiene avisos.",
	"push.denied": "Los avisos están bloqueados para esta app: Ajustes de iOS → Notificaciones → ghostfleet.",
	"push.notAllowed": "No se permitieron los avisos.",
	"push.noKey": "El servidor no tiene clave para avisos.",
	"push.noWorker": "La app no está instalada del todo para recibir avisos: ábrela otra vez desde el ícono.",
	"push.offer": "Activa las notificaciones, para que una sesión que te necesita llegue a este teléfono con la app cerrada.",
	"push.turnOn": "Activar notificaciones",
	"push.notNow": "Ahora no",
	"push.onNow": "Las notificaciones están activas en este dispositivo.",
	"push.unknownThere": "Este dispositivo está suscrito, pero el servidor no lo conoce: apágalo y vuelve a prenderlo.",
	"task.why.page": "la página en la que estás",
	"task.why.jarvis": "el proyecto del asistente",
	"task.why.only": "el único proyecto",
	"task.noProjects": "Todavía no hay un proyecto al que mandar esto.",
	"task.which": "¿Para qué proyecto es esto?",
	"task.gone": "Ese pedido ya no está en la lista.",
	"task.unsent": "No sé si llegó: la página se cerró mientras lo mandaba.",
	"voice.noHear": "Este servidor todavía no puede oír.",
	"phone.event.finished": "Termina de trabajar",
	"phone.event.finished.hint": "pasa de trabajando a lista",
	"phone.event.finished.verb": "termina de trabajar",
	"phone.event.need-you": "Te necesita",
	"phone.event.need-you.hint": "espera una respuesta o un permiso",
	"phone.event.need-you.verb": "te necesita",
	"phone.event.started": "Empieza a trabajar",
	"phone.event.started.hint": "arranca un turno",
	"phone.event.started.verb": "empieza a trabajar",
	"phone.event.limit": "Se queda sin cupo",
	"phone.event.limit.hint": "llega al límite de uso de la cuenta",
	"phone.event.limit.verb": "se queda sin cupo",
	"phone.event.lost": "Se cae",
	"phone.event.lost.hint": "la máquina cerró su proceso",
	"phone.event.lost.verb": "se cae",
	"phone.action.send": "Mandar un prompt",
	"phone.action.spawn": "Crear una sesión",
	"phone.action.pause": "Pausar",
	"phone.action.resume": "Reanudar",
	"phone.action.wake": "Despertar",
	"phone.action.interrupt": "Interrumpir",
	"phone.action.reopen": "Reabrir si se cayó",
	"phone.action.stop": "Detener",
	"phone.action.check": "Seguir solo si…",
	"phone.action.notify": "Avisarme",
	"phone.action.wait": "Esperar",
	"phone.action.summary": "Resumirme el día",
	"phone.scope.personal": "Personal",
	"phone.scope.company": "De la empresa",
	"phone.state.need-you": "te necesita",
	"phone.state.working": "trabajando",
	"phone.state.ready": "lista",
	"phone.state.idle": "inactiva",
	"phone.state.parked": "en pausa",
	"phone.state.limit": "sin cupo",
	"phone.state.interrupted": "interrumpida",
	"phone.state.asleep": "dormida",
	"phone.state.lost": "caída",
	"phone.day.0": "dom",
	"phone.day.1": "lun",
	"phone.day.2": "mar",
	"phone.day.3": "mié",
	"phone.day.4": "jue",
	"phone.day.5": "vie",
	"phone.day.6": "sáb",
	"phone.auto.unnamed": "Automatización sin nombre",
	"phone.auto.err.event": "evento desconocido: {event}",
	"phone.auto.err.triggerSession": "nombre de sesión inválido en el disparador: '{session}'",
	"phone.auto.err.onceDate": "falta la fecha de la ejecución única",
	"phone.auto.err.days": "elige al menos un día de la semana",
	"phone.auto.err.maxSteps": "como mucho {n} pasos",
	"phone.auto.err.action": "paso {i}: acción desconocida '{action}'",
	"phone.auto.err.stepSession": "paso {i}: nombre de sesión inválido '{session}'",
	"phone.auto.err.stepName": "paso {i}: el nombre de la sesión solo puede tener letras, números, espacios y . _ ~ -",
	"phone.auto.err.missing": "paso {i} ({action}): falta {field}",
	"phone.auto.err.confirm": "paso {i}: «{action}» necesita que lo confirmes",
	"phone.auto.err.eventOnly": "paso {i}: «la sesión del evento» solo existe cuando el disparador es un evento",
	"phone.auto.err.noSteps": "agrega al menos una acción",
	"phone.auto.field.status": "al menos un estado",
	"phone.auto.field.project": "el proyecto",
	"phone.auto.field.session": "la sesión",
	"phone.auto.field.prompt": "el mensaje",
	"phone.auto.field.name": "el nombre",
	"phone.auto.field.text": "el texto del aviso",
	"phone.auto.field.minutes": "los minutos",
	"phone.auto.days.all": "todos los días",
	"phone.auto.days.weekdays": "de lunes a viernes",
	"phone.auto.days.weekends": "los fines de semana",
	"phone.auto.days.list": "los {days}",
	"phone.auto.trig.session": "la sesión {session}",
	"phone.auto.trig.anySession": "cualquier sesión",
	"phone.auto.trig.anyProject": "cualquier proyecto",
	"phone.auto.trig.event": "Cuando {who} de {project} {what}",
	"phone.auto.trig.once": "Una vez, el {date} a las {at}",
	"phone.auto.trig.every": "Cada {every}",
	"phone.auto.trig.days": "{days} a las {at}",
	"phone.auto.every.days": "{n} días",
	"phone.auto.every.days.one": "{n} día",
	"phone.auto.step.eventSession": "la sesión del evento",
	"phone.auto.step.send": "Mandar a {where}: «{prompt}»",
	"phone.auto.step.spawn": "Crear la sesión {name} en {project}",
	"phone.auto.step.spawnTask": "Crear la sesión {name} en {project} con una tarea",
	"phone.auto.step.notify": "Avisarme: «{text}»",
	"phone.auto.step.wait": "Esperar {minutes} min",
	"phone.auto.step.summary": "Mandarme un resumen de lo que pasó hoy en mis proyectos",
	"phone.auto.step.check": "Seguir solo si {where} está {states}",
	"phone.auto.or": " o ",
	"phone.tpl.resumen-dia.name": "Resumen de mi día",
	"phone.tpl.resumen-dia.hint": "Cada día a una hora, un resumen de lo que pasó en tus proyectos: aquí, y por Telegram si lo tienes.",
	"phone.tpl.actualizar-pagina.name": "Actualizar datos de una página",
	"phone.tpl.actualizar-pagina.hint": "Cada semana, pedirle al master de un proyecto que actualice los datos de una página.",
	"phone.tpl.actualizar-pagina.prompt": "Actualiza los datos de la página de precios con los valores de esta semana, revisa que se vea bien y abre un PR.",
	"phone.auto.why.notAdmin": "quien la guardó ({who}) ya no es admin",
	"phone.auto.why.disabled": "su cuenta está desactivada",
	"phone.auto.why.noAccess": "{who} ya no tiene acceso a {projects}",
	"phone.auto.why.event": "{where}: {what}",
	"phone.auto.why.manual": "a mano, {who}",
	"phone.auto.notice.paused": "Pausé «{name}»: {why}. Cuando se arregle, vuelve a encenderla.",
	"phone.auto.notice.missed": "«{name}» no se ejecutó el {due}: ghostfleet team estaba apagado a esa hora. No la corrí tarde.",
	"phone.auto.notice.loop": "Apagué «{name}»: se disparó {n} veces en una hora, parece un bucle. Revísala y vuelve a encenderla.",
	"phone.auto.notice.failed": "«{name}» falló en «{step}»: {text}",
	"phone.auto.noDetail": "sin detalle",
	"phone.auto.run.serverOff": "el servidor estaba apagado a esa hora",
	"phone.auto.run.refused": "rechazada: {why}",
	"phone.auto.run.stillRunning": "la ejecución anterior todavía no terminaba",
	"phone.auto.run.running": "ya se está ejecutando",
	"phone.auto.run.tooMany": "apagada por exceso de ejecuciones",
	"phone.auto.step.waited": "esperé {minutes} min",
	"phone.auto.step.notified": "aviso creado",
	"phone.auto.step.noProject": "no hay proyecto: el paso usa el del evento y esto no vino de un evento",
	"phone.auto.step.noSession": "no hay sesión: el paso usa la del evento y esto no vino de un evento",
	"phone.auto.step.refused": "rechazado: {who} no puede hacer eso en '{project}'",
	"phone.auto.step.checkGo": "está {state}: sigo",
	"phone.auto.step.checkHalt": "está {state}: no sigo con los pasos de abajo",
	"phone.auto.step.noLead": "no pude arrancar al líder",
	"phone.auto.err.notFound": "no existe esa automatización",
	"phone.auto.err.companyEdit": "solo un admin edita las automatizaciones de la empresa",
	"phone.auto.err.othersPersonal": "esa automatización es personal de otra persona",
	"phone.auto.err.companyCreate": "solo un admin crea automatizaciones de la empresa",
	"phone.auto.err.companyDelete": "solo un admin borra las automatizaciones de la empresa",
	"phone.auto.err.cannot": "en '{project}' no puedes «{action}»",
	"phone.auto.err.runNow": "solo quien puede editarla la prueba a mano",
	"phone.auto.err.runEvent": "usa «la sesión del evento»: solo puede correr cuando pase el evento",
	"phone.auto.ran": "listo",
	"phone.auto.failed": "falló",
	"phone.common.saving": "Guardando…",
	"phone.nav.automations": "Automatizaciones",
	"phone.project.mine": "Mías",
	"phone.vp.delete": "Borrar a {name}",
	"phone.autos.company": "De la empresa",
	"phone.autos.others": "Personales de otros",
	"phone.autos.sub": "Un disparador y unas acciones: a una hora, o cuando a una sesión le pasa algo.",
	"phone.autos.seen": "Ya los vi",
	"phone.autos.templates": "Plantillas",
	"phone.autos.noCompany": "No hay automatizaciones de la empresa",
	"phone.autos.noCompanyMine": "No hay automatizaciones de la empresa en tus proyectos",
	"phone.autos.companyWhoAdmin": "Las crea un admin; las ve quien tiene acceso a su proyecto.",
	"phone.autos.companyWho": "Las crea un admin de la empresa.",
	"phone.autos.noOthers": "Nadie más tiene automatizaciones personales",
	"phone.autos.none": "Todavía no tienes automatizaciones",
	"phone.autos.example": "Por ejemplo: «de lunes a viernes a las 10:00, mándale al líder de acme-api que revise los pendientes».",
	"phone.autos.createFirst": "Crear la primera",
	"phone.autos.runs": "Últimas ejecuciones",
	"phone.autos.skipped": "se saltó: {why}",
	"phone.autos.ran": "«{name}» corrió",
	"phone.autos.on": "Encendida",
	"phone.autos.off": "Apagada",
	"phone.autos.turnOff": "Apagar {name}",
	"phone.autos.turnOn": "Encender {name}",
	"phone.autos.ownedBy": "de {name}",
	"phone.autos.paused": "En pausa: {why}.",
	"phone.autos.running": "Corriendo ahora…",
	"phone.autos.next": "Próxima: {when}",
	"phone.autos.waitingEvent": "Esperando el evento",
	"phone.autos.last": "última {when}",
	"phone.autos.runningBtn": "Corriendo…",
	"phone.autos.tryNow": "Probar ahora",
	"phone.autos.edit": "Editar",
	"phone.autos.view": "Ver",
	"phone.autos.delTitle": "Borrar la automatización",
	"phone.autos.delBody.a": "Se borra ",
	"phone.autos.delBody.b": ". Lo que ya corrió queda en el historial.",
	"phone.autos.notFound": "No encontré esa automatización.",
	"phone.autos.saved": "«{name}» guardada",
	"phone.autos.savedOff": "«{name}» guardada (apagada)",
	"phone.autos.namePh": "Nombre de la automatización",
	"phone.autos.scope": "Alcance",
	"phone.autos.scopePersonal": "Personal: solo yo, con mis permisos",
	"phone.autos.scopeCompany": "De la empresa: la ve quien tiene su proyecto",
	"phone.autos.roCompany": "Es de la empresa: solo un admin la edita.",
	"phone.autos.roPersonal": "Es personal de {name}: corre con sus permisos, así que solo esa persona la edita.",
	"phone.autos.editor": "Editor",
	"phone.autos.askAI": "Pedírselo a la IA",
	"phone.autos.flow": "Flujo",
	"phone.autos.blocks": "Bloques",
	"phone.autos.triggers": "Disparadores",
	"phone.autos.schedule": "Horario",
	"phone.autos.sessionEvent": "Evento de una sesión",
	"phone.autos.actions": "Acciones",
	"phone.autos.dragHint": "Arrástrala al flujo, o tócala para agregarla al final",
	"phone.autos.dragHelp": "Arrastra un bloque al flujo, o tócalo para sumarlo al final.",
	"phone.autos.dropEmpty": "Arrastra aquí una acción de la izquierda (o tócala)",
	"phone.autos.dropLast": "suelta aquí para agregar al final",
	"phone.autos.when": "Cuándo",
	"phone.autos.event": "Evento",
	"phone.autos.someDays": "Ciertos días",
	"phone.autos.once": "Una vez",
	"phone.autos.everySoOften": "Cada cierto tiempo",
	"phone.autos.days": "Días",
	"phone.autos.date": "Fecha",
	"phone.autos.time": "Hora",
	"phone.autos.every": "Cada",
	"phone.autos.whenSession": "Cuando una sesión…",
	"phone.autos.whichProject": "De qué proyecto",
	"phone.autos.anyProject": "Cualquier proyecto",
	"phone.autos.whichSession": "Qué sesión",
	"phone.autos.any": "Cualquiera",
	"phone.autos.cooldown": "No repetir con la misma sesión antes de (min)",
	"phone.autos.dragMove": "Arrastra para mover",
	"phone.autos.up": "Subir",
	"phone.autos.down": "Bajar",
	"phone.autos.removeStep": "Quitar paso",
	"phone.autos.project": "Proyecto",
	"phone.autos.choose": "Elige…",
	"phone.autos.eventProject": "El del evento",
	"phone.autos.session": "Sesión",
	"phone.autos.newName": "Nombre de la sesión nueva",
	"phone.autos.firstTask": "Tarea inicial (opcional)",
	"phone.autos.resumeMsg": "Mensaje al reanudar (opcional)",
	"phone.autos.vars": "Puedes usar {fecha}, {hora}, {proyecto}, {sesion}",
	"phone.autos.branchOpt": "Rama (opcional)",
	"phone.autos.noticeText": "Texto del aviso",
	"phone.autos.noticePh": "{sesion} terminó en {proyecto}",
	"phone.autos.ifNow": "…si ahora está",
	"phone.autos.states": "Estados",
	"phone.autos.checkHint": "Si no está así, la automatización termina aquí (no cuenta como error).",
	"phone.autos.summaryHint": "Lo que pasó hoy en los proyectos de quien corre la automatización: quién hizo qué, qué sigue trabajando y quién te necesita. Llega como aviso aquí, y también por Telegram si eres quien tiene fleet-telegram en esta máquina.",
	"phone.autos.minutes": "Minutos (1 a 60)",
	"phone.autos.confirmStop": "Confirmo que esta automatización puede detener la sesión (el worktree queda libre, no se borra)",
	"phone.autos.aiFailed": "No pude: {why}",
	"phone.autos.aiHint": "Dile qué quieres en una frase, por ejemplo: «todos los días a las 9, despierta a los workers de acme-web y mándale al líder que reparta lo pendiente». Arma los bloques y tú revisas antes de guardar.",
	"phone.autos.aiApplied": "Lo puse en el editor",
	"phone.autos.undo": "deshacer",
	"phone.autos.aiBusy": "Armándolo…",
	"phone.autos.aiPh": "¿Qué quieres automatizar?",
	"phone.search": "Buscar",
	"phone.searchHint": "Busca un proyecto o una sesión",
	"phone.projects": "Proyectos",
	"phone.sessions": "Sesiones",
	"phone.noMatches": "No hay coincidencias",
	"phone.held": "Pendientes retenidos",
	"phone.openHeld": "Abrir el cuadro de entrada",
	"phone.heldHint": "Una activación espera a que el cuadro de entrada esté vacío. Abre la sesión para enviar o borrar el texto.",
	"phone.nothingWaiting": "No tienes nada pendiente",
	"phone.signIns": "Inicios de sesión pendientes",
	"phone.noSignIns": "No hay inicios de sesión pendientes",
	"phone.loginStarted": "Inicio de sesión listo",
	"phone.loginStartFailed": "No se pudo iniciar sesión",
	"phone.loginDone": "Inicio de sesión completado",
	"phone.loginFailed": "No se pudo completar el inicio de sesión. Revisa la sesión e intenta de nuevo.",
	"phone.loginReadFailed": "No se pudieron consultar los inicios de sesión",
	"phone.thisHost": "Este equipo",
	"phone.firstSite": "Es la primera vez en este sitio. Revisa el proveedor antes de abrirlo.",
	"phone.signIn": "Iniciar sesión",
	"phone.openConnector": "Abrir los ajustes del conector",
	"phone.open": "Abrir",
	"phone.code": "Código de inicio de sesión de Claude",
	"phone.callback": "URL completa de redirección",
	"phone.finishLogin": "Completar y confirmar el inicio de sesión",
	"phone.expires": "Vence en {time}",
	"phone.expired": "Venció",
	"phone.queue": "Cola",
	"phone.reply": "Responder",
	"phone.replyHint": "Se envía al líder citando este pendiente. Sale de la lista cuando el líder lo cierra.",
	"phone.stacks": "Grupos de sesiones",
	"phone.openStack": "Abrir grupo · {n}",
	"phone.noSessions": "No hay sesiones para elegir",
	"phone.editStack": "Elegir sesiones",
	"phone.emptyStack": "Elige sesiones para armar un grupo",
	"phone.openSession": "Abrir sesión",
	"phone.reviews": "Revisiones",
	"phone.review": "Revisión",
	"phone.reviewsOff": "Las revisiones están desactivadas",
	"phone.noBranch": "Sin rama",
	"phone.video": "Video",
	"phone.stills": "Imágenes",
	"phone.steps": "{n} pasos",
	"phone.earlier": "{n} ejecuciones anteriores",
	"phone.noReviews": "Todavía no hay ejecuciones grabadas",
	"phone.hostMissing": "{host} no respondió",
	"phone.saved": "Guardado",
	"phone.saveFailed": "No se pudo guardar",
	"phone.saving": "Guardando…",
	"phone.retry": "Intentar de nuevo",
	"phone.approve": "Aprobar",
	"phone.reject": "Rechazar",
	"phone.reviewNote": "Nota de revisión",
	"phone.restOk": "Marcar los pasos restantes como correctos",
	"phone.chapter": "Ir al capítulo",
	"phone.ok": "Correcto",
	"phone.problem": "Problema",
	"phone.skip": "Omitir",
	"phone.requests": "Solicitudes · {n}",
	"phone.autoNameExample": "revision-{fecha}",
	"phone.event.interrupted": "Interrumpido",
	"phone.event.interrupted.hint": "Se interrumpió un turno",
	"phone.event.interrupted.verb": "se interrumpe",
	"phone.state.starting": "iniciando",
	"phone.state.unknown": "sin datos",
	"phone.approved": "Aprobado. La revisión pasa la verificación",
	"phone.rejected": "Rechazado. Se necesitan cambios",
	"phone.unreviewed": "Sin revisar. Marca cada paso o revisa la grabación",
	"phone.changesNeeded": "Algunos pasos necesitan cambios",
	"phone.reasonNeeded": "Los pasos con alertas necesitan una explicación escrita",
	"phone.queueState.waiting": "Esperando",
	"phone.queueState.replied": "Respondido",
	"phone.cardHeld": "Retenido",
	"phone.signInFailed": "Falló el inicio de sesión",
	"phone.stackPlace": "Grupos de sesiones",
	"phone.autoReadOnly": "Esta automatización es de solo lectura.",
	"phone.steps.one": "{n} paso",
	"phone.earlier.one": "{n} ejecución anterior",
	"phone.requests.one": "Solicitud · {n}",
	"phone.auto.err.maxSteps.one": "como mucho {n} paso",
	"phone.auto.notice.loop.one": "Apagué «{name}»: se disparó {n} vez en una hora, parece un bucle. Revísala y vuelve a encenderla."
};
//#endregion
//#region web/ui/i18n.js
var CATALOGS = {
	en: { ...en_default },
	es: { ...es_default }
};
var LANGS = ["en", "es"];
var LANG_NAMES = {
	en: "English",
	es: "Español"
};
var pickLang = (s) => /^es(\b|[-_])/i.test(String(s || "").trim()) ? "es" : "en";
var normLang = (s) => LANGS.includes(s) ? s : null;
var source = () => "en";
function setLangSource(fn) {
	source = fn;
}
var lang = () => normLang(source()) || "en";
var locale = () => lang();
var isMsg = (x) => !!x && typeof x === "object" && typeof x.k === "string";
function translate(l, key, vars) {
	const cat = CATALOGS[l] || CATALOGS.en;
	const k = vars && vars.n === 1 && key + ".one" in cat ? key + ".one" : key;
	let s = cat[k] ?? CATALOGS.en[k] ?? key;
	if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => name in vars ? String(word(vars[name], l) ?? "") : m);
	return s;
}
var word = (v, l) => isMsg(v) ? translate(l, v.k, v.v) : v && typeof v === "object" && typeof v.at === "number" ? (/* @__PURE__ */ new Date(v.at * 1e3)).toLocaleString(l, {
	weekday: "short",
	day: "2-digit",
	month: "short",
	hour: "2-digit",
	minute: "2-digit"
}) : v;
var t = (key, vars) => translate(lang(), key, vars);
function worded(table, prefix, fields = ["label"]) {
	for (const [k, v] of Object.entries(table)) for (const f of fields) {
		const key = f === "label" ? `${prefix}.${k}` : `${prefix}.${k}.${f}`;
		Object.defineProperty(v, f, {
			get: () => t(key),
			enumerable: true,
			configurable: true
		});
	}
	return table;
}
function words(keys, prefix) {
	const o = {};
	for (const k of keys) Object.defineProperty(o, k, {
		get: () => t(`${prefix}.${k}`),
		enumerable: true
	});
	return o;
}
//#endregion
//#region web/ui/lights.js
var LIGHTS = worded({
	work: {
		color: "green",
		motion: "sail"
	},
	start: {
		color: "green",
		motion: "sail"
	},
	wait: {
		color: "yellow",
		motion: "signal"
	},
	error: {
		color: "red",
		motion: "list"
	},
	done: {
		color: "cyan",
		motion: "moored"
	},
	idle: {
		color: "grey",
		motion: "moored"
	},
	off: {
		color: "grey",
		motion: "ghost"
	}
}, "light");
var STATUS_LIGHT = {
	working: "work",
	starting: "start",
	"need-you": "wait",
	limit: "error",
	interrupted: "error",
	unknown: "error",
	lost: "error",
	ready: "done",
	idle: "idle",
	parked: "off",
	asleep: "off"
};
var lightOf = (status) => STATUS_LIGHT[status] || "error";
var colorOf = (status) => LIGHTS[lightOf(status)].color;
var URGENCY = [
	"wait",
	"error",
	"work",
	"start",
	"done",
	"idle",
	"off"
];
function topLight(statuses) {
	let best = null;
	for (const s of statuses) {
		const l = lightOf(s);
		if (best == null || URGENCY.indexOf(l) < URGENCY.indexOf(best)) best = l;
	}
	return best || "off";
}
//#endregion
//#region web/ui/sprite.js
var SHIP = [
	"         ▄▄▄▄▄▄█                ",
	"         ▀▀▀▀▀ █                ",
	"          ▄▄███████▄▄▄          ",
	"       ▄██████ ███ ████▄      ▄▀",
	"     ▄██████████████████    ▄▀  ",
	"   ▄██▀▀████▀▀████▀▀███   ▄▀    ",
	"▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀      ",
	"  ▀▀▀█████████████████▀▀        "
];
var PIXELS = (() => {
	const px = [];
	SHIP.forEach((row, y) => [...row].forEach((ch, x) => {
		if (ch === "▀" || ch === "█") px.push([x, y * 2]);
		if (ch === "▄" || ch === "█") px.push([x, y * 2 + 1]);
	}));
	return px;
})();
var MAST = [15, 0];
//#endregion
//#region web/ui/fleet.jsx
var asLight = (state) => LIGHTS[state] ? state : lightOf(state);
function Led({ state, size = 9, label, hidden, class: cls = "" }) {
	const l = asLight(state);
	const name = label || LIGHTS[l].label;
	const a11y = hidden ? { "aria-hidden": "true" } : {
		role: "img",
		"aria-label": name,
		title: name
	};
	return /* @__PURE__ */ u("span", {
		class: `led l-${l} c-${LIGHTS[l].color} ${cls}`,
		style: { "--led": `${size}px` },
		...a11y
	});
}
function Ship({ state, size = 46, title }) {
	const l = asLight(state);
	const { color, motion } = LIGHTS[l];
	const h = Math.round(size * 19 / 32);
	return /* @__PURE__ */ u("span", {
		class: `fship l-${l} m-${motion} c-${color}`,
		style: {
			"--w": `${size}px`,
			"--h": `${h}px`
		},
		title,
		children: [
			/* @__PURE__ */ u("span", {
				class: "fship-sea",
				"aria-hidden": "true"
			}),
			motion === "sail" ? /* @__PURE__ */ u("span", {
				class: "fship-wake",
				"aria-hidden": "true"
			}) : null,
			/* @__PURE__ */ u("svg", {
				class: "fship-hull",
				viewBox: "0 -3 32 19",
				width: size,
				height: h,
				"shape-rendering": "crispEdges",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ u("g", {
					class: "fship-body",
					children: PIXELS.map(([x, y]) => /* @__PURE__ */ u("rect", {
						x,
						y,
						width: "1",
						height: "1"
					}, `${x}-${y}`))
				}), /* @__PURE__ */ u("rect", {
					class: "fship-lamp",
					x: MAST[0] - 1,
					y: MAST[1] - 3,
					width: "3",
					height: "3"
				})]
			}),
			l === "off" ? /* @__PURE__ */ u("span", {
				class: "fship-z",
				"aria-hidden": "true",
				children: "z"
			}) : null
		]
	});
}
function Harbor() {
	return /* @__PURE__ */ u("div", {
		class: "harbor",
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ u("div", {
				class: "harbor-sky",
				children: /* @__PURE__ */ u("span", {
					class: "harbor-ghost",
					children: /* @__PURE__ */ u(Ship, {
						state: "done",
						size: 96
					})
				})
			}),
			/* @__PURE__ */ u("div", {
				class: "harbor-fleet",
				children: [
					/* @__PURE__ */ u(Ship, {
						state: "work",
						size: 32
					}),
					/* @__PURE__ */ u(Ship, {
						state: "wait",
						size: 32
					}),
					/* @__PURE__ */ u(Ship, {
						state: "off",
						size: 32
					})
				]
			}),
			/* @__PURE__ */ u("div", { class: "harbor-waves" })
		]
	});
}
function GhostShip({ size = 64, state = "idle", title }) {
	return /* @__PURE__ */ u("span", {
		class: `ship st-${state}`,
		style: {
			width: size,
			height: size / 2
		},
		title,
		children: /* @__PURE__ */ u("svg", {
			viewBox: "0 0 32 16",
			width: size,
			height: size / 2,
			"shape-rendering": "crispEdges",
			"aria-hidden": "true",
			children: PIXELS.map(([x, y]) => /* @__PURE__ */ u("rect", {
				x,
				y,
				width: "1",
				height: "1"
			}, `${x}-${y}`))
		})
	});
}
//#endregion
//#region web/ui/icon.jsx
var ROWS = {
	home: [
		"............",
		".....##.....",
		"....####....",
		"...##..##...",
		"..##....##..",
		".##......##.",
		"..#......#..",
		"..#..##..#..",
		"..#..##..#..",
		"..#..##..#..",
		"..########..",
		"............"
	],
	map: [
		".....#......",
		".....##.....",
		"...#.###....",
		"..##.####...",
		".###.#####..",
		".....#......",
		"############",
		".##########.",
		"..########..",
		"............",
		".##..##..##.",
		"#..##..##..#"
	],
	bolt: [
		".......##...",
		"......##....",
		".....###....",
		"....###.....",
		"...#######..",
		"..#######...",
		".....###....",
		"....###.....",
		"....##......",
		"...##.......",
		"...#........",
		"............"
	],
	list: [
		"............",
		"##.#########",
		"............",
		"............",
		"##.######...",
		"............",
		"............",
		"##.#########",
		"............",
		"............",
		"##.#####....",
		"............"
	],
	key: [
		"............",
		"............",
		"............",
		".####.......",
		"##..##......",
		"#....#######",
		"#....#######",
		"##..##..##.#",
		".####...##.#",
		"............",
		"............",
		"............"
	],
	gear: [
		".....##.....",
		".##.####.##.",
		".##########.",
		"..########..",
		".####..####.",
		"####....####",
		"####....####",
		".####..####.",
		"..########..",
		".##########.",
		".##.####.##.",
		".....##....."
	],
	logout: [
		"######......",
		"#....#......",
		"#....#......",
		"#....#...#..",
		"#....#....#.",
		"#..#########",
		"#....#....#.",
		"#....#...#..",
		"#....#......",
		"#....#......",
		"######......",
		"............"
	],
	menu: [
		"............",
		"############",
		"############",
		"............",
		"............",
		"############",
		"############",
		"............",
		"............",
		"############",
		"############",
		"............"
	],
	mic: [
		"....####....",
		"...######...",
		"...######...",
		"...######...",
		"...######...",
		".#.######.#.",
		".#..####..#.",
		"..#......#..",
		"...######...",
		".....##.....",
		".....##.....",
		"...######..."
	],
	clip: [
		".....###....",
		"....#...#...",
		"....#...#...",
		"....#.#.#...",
		"....#.#.#...",
		"....#.#.#...",
		"....#.#.#...",
		"....#.#.#...",
		"....#...#...",
		"....#...#...",
		".....###....",
		"............"
	],
	chat: [
		"............",
		".##########.",
		"#..........#",
		"#..........#",
		"#..........#",
		"#..........#",
		"#..........#",
		".###.######.",
		"...#.#......",
		"...##.......",
		"...#........",
		"............"
	],
	tag: [
		"............",
		"............",
		"########....",
		"#.......#...",
		"#.##.....#..",
		"#.##......#.",
		"#.........#.",
		"#........#..",
		"#.......#...",
		"########....",
		"............",
		"............"
	],
	clock: [
		"...######...",
		"..#......#..",
		".#........#.",
		"#....#.....#",
		"#....#.....#",
		"#....#.....#",
		"#....####..#",
		"#..........#",
		"#..........#",
		".#........#.",
		"..#......#..",
		"...######..."
	],
	bell: [
		".....##.....",
		"....####....",
		"...#....#...",
		"..#......#..",
		"..#......#..",
		"..#......#..",
		"..#......#..",
		".#........#.",
		"#..........#",
		"############",
		"............",
		".....##....."
	],
	lock: [
		"....####....",
		"...#....#...",
		"..#......#..",
		"..#......#..",
		"..#......#..",
		".##########.",
		".##########.",
		".####..####.",
		".####..####.",
		".#####.####.",
		".##########.",
		".##########."
	],
	search: [
		"..####......",
		".#....#.....",
		"#......#....",
		"#......#....",
		"#......#....",
		"#......#....",
		".#....#.....",
		"..####.##...",
		".......###..",
		"........###.",
		".........###",
		"..........##"
	],
	close: [
		"............",
		".##......##.",
		"..##....##..",
		"...##..##...",
		"....####....",
		".....##.....",
		".....##.....",
		"....####....",
		"...##..##...",
		"..##....##..",
		".##......##.",
		"............"
	],
	play: [
		"...#........",
		"...##.......",
		"...###......",
		"...####.....",
		"...#####....",
		"...######...",
		"...######...",
		"...#####....",
		"...####.....",
		"...###......",
		"...##.......",
		"...#........"
	],
	pause: [
		"............",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"..###..###..",
		"............"
	],
	stop: [
		"............",
		"............",
		"..########..",
		"..########..",
		"..########..",
		"..########..",
		"..########..",
		"..########..",
		"..########..",
		"..########..",
		"............",
		"............"
	],
	check: [
		"............",
		"............",
		"..........##",
		".........##.",
		"........##..",
		".##....##...",
		"..##..##....",
		"...####.....",
		"....##......",
		"............",
		"............",
		"............"
	],
	warning: [
		".....##.....",
		".....##.....",
		"....#..#....",
		"....#..#....",
		"...#.##.#...",
		"...#.##.#...",
		"..#..##..#..",
		"..#..##..#..",
		".#........#.",
		".#...##...#.",
		"#..........#",
		"############"
	],
	moon: [
		"....###.....",
		"..###.......",
		".###........",
		".##.........",
		"###.........",
		"###.........",
		"###.........",
		"###.........",
		".###.......#",
		".####....##.",
		"..########..",
		"....####...."
	],
	sun: [
		".....##.....",
		".#...##...#.",
		"..#......#..",
		"....####....",
		"...######...",
		"##.######.##",
		"##.######.##",
		"...######...",
		"....####....",
		"..#......#..",
		".#...##...#.",
		".....##....."
	],
	hourglass: [
		".##########.",
		"..#......#..",
		"..#......#..",
		"..##....##..",
		"...##..##...",
		"....####....",
		"....####....",
		"...##..##...",
		"..#..##..#..",
		"..#.####.#..",
		"..########..",
		".##########."
	],
	mail: [
		"............",
		"............",
		"############",
		"##........##",
		"#.#......#.#",
		"#..#....#..#",
		"#...####...#",
		"#..........#",
		"#..........#",
		"############",
		"............",
		"............"
	],
	plus: [
		"............",
		".....##.....",
		".....##.....",
		".....##.....",
		".....##.....",
		".##########.",
		".##########.",
		".....##.....",
		".....##.....",
		".....##.....",
		".....##.....",
		"............"
	],
	hand: [
		"....#.#.....",
		"..#.#.#.#...",
		"..#.#.#.#...",
		"..#.#.#.#...",
		"..#######.#.",
		"..#######.#.",
		"..########..",
		"..#######...",
		"...######...",
		"...#####....",
		"...#####....",
		"............"
	],
	refresh: [
		"....####....",
		"..##....##.#",
		".#........##",
		".#.......###",
		"#...........",
		"#...........",
		"...........#",
		"...........#",
		"###.......#.",
		"##........#.",
		"#.##....##..",
		"....####...."
	],
	question: [
		"...######...",
		"..##....##..",
		"..##....##..",
		"........##..",
		".......##...",
		"......##....",
		".....##.....",
		".....##.....",
		"............",
		".....##.....",
		".....##.....",
		"............"
	],
	clipboard: [
		"....####....",
		".###.##.###.",
		".#........#.",
		".#.######.#.",
		".#........#.",
		".#.######.#.",
		".#........#.",
		".#.####...#.",
		".#........#.",
		".#........#.",
		".##########.",
		"............"
	],
	file: [
		".######.....",
		".#....##....",
		".#....#.#...",
		".#....####..",
		".#.......#..",
		".#.......#..",
		".#.......#..",
		".#.......#..",
		".#.......#..",
		".#.......#..",
		".#.......#..",
		".#########.."
	],
	folder: [
		"............",
		"#####.......",
		"#....#######",
		"#..........#",
		"#..........#",
		"#..........#",
		"#..........#",
		"#..........#",
		"#..........#",
		"#..........#",
		"############",
		"............"
	],
	branch: [
		".##......##.",
		".##......##.",
		".#........#.",
		".#........#.",
		".#.......#..",
		".#......#...",
		".#....##....",
		".#..##......",
		".###........",
		".#..........",
		".##.........",
		".##........."
	],
	spark: [
		".....#......",
		".....#......",
		"....###.....",
		".#########..",
		"....###.....",
		".....#......",
		".....#....#.",
		".........###",
		"..........#.",
		".#..........",
		"###.........",
		".#.........."
	],
	back: [
		"............",
		"....#.......",
		"...##.......",
		"..##........",
		".##########.",
		"###########.",
		".##########.",
		"..##........",
		"...##.......",
		"....#.......",
		"............",
		"............"
	],
	keyboard: [
		"............",
		"............",
		"############",
		"#..........#",
		"#.##.##.##.#",
		"#..........#",
		"#.##.##.##.#",
		"#..........#",
		"#..######..#",
		"#..........#",
		"############",
		"............"
	],
	term: [
		"............",
		"############",
		"#..........#",
		"#.#........#",
		"#..#.......#",
		"#...#......#",
		"#..#.......#",
		"#.#..####..#",
		"#..........#",
		"############",
		"............",
		"............"
	],
	link: [
		"............",
		".......####.",
		"......#....#",
		"......#....#",
		".......##..#",
		"....##..#.#.",
		".#.#..##....",
		"#..##.......",
		"#....#......",
		"#....#......",
		".####.......",
		"............"
	]
};
function runs(rows) {
	let d = "";
	rows.forEach((r, y) => {
		for (let x = 0; x < r.length;) {
			if (r[x] !== "#") {
				x++;
				continue;
			}
			let e = x;
			while (r[e + 1] === "#") e++;
			d += `M${x} ${y}h${e - x + 1}v1h-${e - x + 1}z`;
			x = e + 1;
		}
	});
	return d;
}
var PATHS = Object.fromEntries(Object.entries(ROWS).map(([k, rows]) => [k, runs(rows)]));
Object.keys(ROWS);
function Icon({ name, size = 12, label, class: cls }) {
	const d = PATHS[name];
	if (!d) return null;
	return /* @__PURE__ */ u("svg", {
		class: `px-ico${cls ? ` ${cls}` : ""}`,
		viewBox: "0 0 12 12",
		width: size,
		height: size,
		role: label ? "img" : void 0,
		"aria-label": label,
		"aria-hidden": label ? void 0 : "true",
		children: /* @__PURE__ */ u("path", { d })
	});
}
//#endregion
//#region web/ui/ui.jsx
var STATUS = {
	"need-you": { glyph: "●" },
	working: { glyph: "◆" },
	ready: { glyph: "✓" },
	parked: { icon: "pause" },
	idle: { glyph: "·" },
	starting: { glyph: "…" },
	limit: { icon: "hourglass" },
	interrupted: { icon: "warning" },
	unknown: { glyph: "?" },
	asleep: { icon: "moon" },
	lost: { glyph: "✕" }
};
worded(STATUS, "status", ["label", "hint"]);
for (const [k, v] of Object.entries(STATUS)) v.color = colorOf(k);
var statusOf = (c) => (c.lost ? "lost" : c.asleep ? "asleep" : c.status) || "unknown";
function StatusMark({ status }) {
	const s = STATUS[status] || STATUS.unknown;
	return s.icon ? /* @__PURE__ */ u(Icon, { name: s.icon }) : s.glyph;
}
function StatusPill({ status, small }) {
	const s = STATUS[status] || STATUS.unknown;
	return /* @__PURE__ */ u("span", {
		class: `pill c-${s.color}${small ? " sm" : ""}`,
		title: s.hint,
		children: [
			/* @__PURE__ */ u(Led, {
				state: status,
				size: small ? 7 : 8,
				hidden: true
			}),
			" ",
			s.label
		]
	});
}
function Btn({ kind = "", icon, children, ...rest }) {
	return /* @__PURE__ */ u("button", {
		type: "button",
		class: `btn ${kind}`,
		...rest,
		children: [icon ? /* @__PURE__ */ u(Icon, { name: icon }) : null, children]
	});
}
function Logo({ size = 28 }) {
	return /* @__PURE__ */ u("span", {
		class: "logo",
		style: {
			width: size,
			height: size
		},
		"aria-hidden": "true",
		children: /* @__PURE__ */ u("svg", {
			viewBox: "-4 -10 40 36",
			width: size,
			height: size,
			"shape-rendering": "crispEdges",
			children: PIXELS.map(([x, y]) => /* @__PURE__ */ u("rect", {
				x,
				y,
				width: "1",
				height: "1"
			}, `${x}-${y}`))
		})
	});
}
function ago(sec) {
	if (sec == null) return "";
	const s = Math.max(0, Math.round(sec));
	if (s < 60) return t("ago.now");
	const m = Math.round(s / 60);
	if (m < 60) return t("ago.min", { n: m });
	const h = Math.round(m / 60);
	if (h < 24) return t("ago.h", { n: h });
	return t("ago.d", { n: Math.round(h / 24) });
}
var sinceTs = (ts) => ts ? ago(Date.now() / 1e3 - ts) : "";
var clock = (ts) => (/* @__PURE__ */ new Date(ts * 1e3)).toLocaleString(locale(), {
	day: "2-digit",
	month: "short",
	hour: "2-digit",
	minute: "2-digit"
});
function usePoll(fn, ms, deps) {
	const [data, setData] = d(null);
	const [error, setError] = d(null);
	const [loading, setLoading] = d(true);
	const live = A(0);
	const out = A(0);
	const run = q(async () => {
		const id = live.current;
		out.current++;
		try {
			const d = await fn();
			if (id === live.current) {
				setData(d);
				setError(null);
			}
		} catch (e) {
			if (id === live.current) setError(e);
		} finally {
			out.current--;
			if (id === live.current) setLoading(false);
		}
	}, deps);
	h(() => {
		live.current++;
		setLoading(true);
		setData(null);
		run();
		if (!ms) return void 0;
		const iv = setInterval(() => {
			if (!document.hidden && !out.current) run();
		}, ms);
		return () => clearInterval(iv);
	}, [run]);
	return {
		data,
		error,
		loading,
		reload: run
	};
}
function Markdown({ text }) {
	const ref = A(null);
	_(() => {
		const n = ref.current;
		if (!n) return;
		n.replaceChildren();
		try {
			n.append(render(String(text || ""), document));
		} catch {
			n.textContent = text;
		}
	}, [text]);
	return /* @__PURE__ */ u("div", {
		class: "md",
		ref
	});
}
var pushToast = () => {};
var toast = (text, kind = "", icon = null) => pushToast({
	text,
	kind,
	icon,
	id: Math.random()
});
function Toasts() {
	const [list, setList] = d([]);
	pushToast = (m) => {
		setList((l) => [...l, m]);
		setTimeout(() => setList((l) => l.filter((x) => x.id !== m.id)), m.kind === "bad" ? 7e3 : 3500);
	};
	return /* @__PURE__ */ u("div", {
		class: "toasts",
		children: list.map((m) => /* @__PURE__ */ u("div", {
			class: `toast ${m.kind}`,
			children: [m.icon ? /* @__PURE__ */ u(Icon, { name: m.icon }) : null, m.text]
		}, m.id))
	});
}
var splitAddr = (n) => {
	const m = /^(.+)@([^@]+)$/.exec(String(n || ""));
	return m ? [m[1], m[2]] : [String(n || ""), ""];
};
function ProjectName({ name }) {
	const [bare, host] = splitAddr(name);
	return host ? /* @__PURE__ */ u(S$1, { children: [bare, /* @__PURE__ */ u("small", {
		class: "at",
		children: [" · ", host]
	})] }) : bare;
}
function Modal({ title, onClose, children, wide }) {
	h(() => {
		const k = (e) => {
			if (e.key === "Escape") onClose();
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [onClose]);
	return /* @__PURE__ */ u("div", {
		class: "scrim",
		onMouseDown: (e) => {
			if (e.target === e.currentTarget) onClose();
		},
		children: /* @__PURE__ */ u("div", {
			class: `modal${wide ? " wide" : ""}`,
			role: "dialog",
			"aria-modal": "true",
			"aria-label": title,
			children: [/* @__PURE__ */ u("header", { children: [/* @__PURE__ */ u("h2", { children: title }), /* @__PURE__ */ u("button", {
				class: "x",
				"aria-label": t("common.close"),
				onClick: onClose,
				children: /* @__PURE__ */ u(Icon, { name: "close" })
			})] }), children]
		})
	});
}
function Confirm({ title, body, action, danger, typed, onYes, onClose }) {
	const [busy, setBusy] = d(false);
	const [txt, setTxt] = d("");
	const ok = !typed || txt.trim() === typed;
	const yes = async () => {
		setBusy(true);
		try {
			await onYes();
			onClose();
		} finally {
			setBusy(false);
		}
	};
	const live = A();
	live.current = {
		yes,
		busy
	};
	h(() => {
		if (typed) return;
		const k = (e) => {
			if (e.key !== "y" && e.key !== "Y" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typingIn(e.target)) return;
			e.preventDefault();
			if (!live.current.busy) live.current.yes();
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [typed]);
	return /* @__PURE__ */ u(Modal, {
		title,
		onClose,
		children: [
			/* @__PURE__ */ u("div", {
				class: "modal-body",
				children: body
			}),
			typed ? /* @__PURE__ */ u("label", {
				class: "field",
				children: [/* @__PURE__ */ u("span", { children: [
					t("ui.typeTo.a"),
					/* @__PURE__ */ u("code", { children: typed }),
					t("ui.typeTo.b")
				] }), /* @__PURE__ */ u("input", {
					value: txt,
					onInput: (e) => setTxt(e.currentTarget.value),
					autoFocus: true
				})]
			}) : null,
			/* @__PURE__ */ u("footer", { children: [/* @__PURE__ */ u(Btn, {
				onClick: onClose,
				children: t("common.cancel")
			}), /* @__PURE__ */ u(Btn, {
				kind: danger ? "danger" : "primary",
				disabled: !ok || busy,
				onClick: yes,
				children: busy ? t("common.wait") : action
			})] })
		]
	});
}
//#endregion
//#region web/ui/keyboard.jsx
var screens = [];
function useKeys(handler) {
	const ref = A(handler);
	ref.current = handler;
	h(() => {
		const h = (key, e, layer) => ref.current(key, e, layer);
		screens.push(h);
		return () => {
			const i = screens.lastIndexOf(h);
			if (i >= 0) screens.splice(i, 1);
		};
	}, []);
}
var sessionTo = (project, name) => `/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`;
var projectTo = (project) => `/p/${encodeURIComponent(project)}`;
var leadIn = (list) => (list || []).find((s) => s.lead)?.name || null;
function moveFocus(selector, dir) {
	const els = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length);
	const from = els.indexOf(document.activeElement);
	const to = stepIndex(els.map((el) => el.getBoundingClientRect()), from, dir);
	if (to < 0) return false;
	els[to].focus();
	els[to].scrollIntoView?.({ block: "nearest" });
	return true;
}
var dirOf = (key) => !key.ctrl && !key.alt && !(key.shift && key.k.startsWith("Arrow")) ? DIRS[key.k] : void 0;
var OWN = "a[href], button, summary, select, [role=\"button\"], [role=\"tab\"], [tabindex]:not([tabindex=\"-1\"])";
var ownActivation = (e) => (e.key === "Enter" || e.key === " ") && !!e.target?.closest?.(OWN) && e.target !== document.body;
var dialogOpen = () => !!document.querySelector("[aria-modal=\"true\"]");
var inComposer = (t) => !!t?.closest?.(".composer");
function jumpText(j) {
	if (j.stage === "grid") return t("keys.jump.grid");
	if (j.stage === "proj") return t("keys.jump.proj", { n: j.proj });
	return t("keys.jump.first");
}
function DeskKeys({ route, projects, settings, openMenu }) {
	const fleet = useFleet();
	const [jump, setJump] = d(null);
	const live = A({});
	live.current = {
		route,
		projects,
		settings,
		openMenu,
		fleet,
		jump
	};
	const prefix = A(false);
	h(() => {
		const now = () => live.current;
		const go = (to, opts) => now().fleet.go(to, opts);
		const nth = (n) => (now().projects || [])[n - 1] || null;
		const layer = {
			get prefix() {
				return prefix.current;
			},
			set prefix(v) {
				prefix.current = !!v;
			},
			held: () => !!now().jump || prefix.current,
			startJump: () => setJump({ stage: "first" }),
			go,
			toLead(project, cards) {
				const p = (now().projects || []).find((x) => x.name === project);
				const name = leadIn(cards) || leadIn(p?.sessions);
				if (name) go(sessionTo(project, name));
				return true;
			},
			focusSearch() {
				let tries = 0;
				const focus = () => {
					const box = document.querySelector(".side .search");
					if (box && box.getClientRects().length) {
						box.focus();
						box.select?.();
						return;
					}
					if (tries++ < 10) requestAnimationFrame(focus);
				};
				if (matchMedia("(max-width: 900px)").matches) now().openMenu?.();
				focus();
				return true;
			}
		};
		const follow = async (g) => {
			if (g.to === "projects") return go("/");
			const p = nth(g.project);
			if (!p) return;
			if (g.to === "master") return layer.toLead(p.name);
			go(projectTo(p.name));
			if (g.to !== "card") return;
			try {
				const c = ((await now().fleet.grid(p.name))?.cards || [])[g.card - 1];
				if (c) go(sessionTo(p.name, c.name), { replace: true });
			} catch {}
		};
		const shared = (key) => {
			const { k, lk, ctrl } = key;
			const view = now().route?.view;
			if (ctrl && lk === "f") {
				layer.startJump();
				return true;
			}
			if (ctrl && lk === "p") {
				if (view === "home") return false;
				go("/");
				return true;
			}
			if (ctrl || key.alt) return false;
			if (k === "Q" && view !== "home") {
				go("/");
				return true;
			}
			if (k === "," && now().settings && (view === "home" || view === "project" && !now().route.session)) {
				go(now().settings);
				return true;
			}
			if (k === "/" && view === "home") return layer.focusSearch();
			return false;
		};
		const onKey = (e) => {
			if (dialogOpen()) return;
			const session = now().route?.view === "project" && !!now().route.session;
			if (typingIn(e.target) && !(session && inComposer(e.target) && deskKeyInComposer(e, { held: layer.held() }))) return;
			if (!layer.held() && ownActivation(e)) return;
			const key = deskKey(e);
			if (!key) return;
			if (now().jump) {
				e.preventDefault();
				const r = jumpStep(now().jump, key);
				setJump(r.j);
				if (r.go) follow(r.go);
				return;
			}
			const top = screens[screens.length - 1];
			if (top && top(key, e, layer) || shared(key)) e.preventDefault();
		};
		addEventListener("keydown", noteKeyboard, true);
		addEventListener("keydown", onKey);
		return () => {
			removeEventListener("keydown", noteKeyboard, true);
			removeEventListener("keydown", onKey);
		};
	}, []);
	if (!jump) return null;
	const hints = jumpText(jump).split(/\s+·\s+/);
	return /* @__PURE__ */ u("p", {
		class: "keyprompt",
		role: "status",
		children: hints.map((h, i) => /* @__PURE__ */ u(S$1, { children: [i ? " · " : "", /* @__PURE__ */ u("span", { children: h })] }))
	});
}
function typeIntoComposer(text) {
	const box = document.querySelector(".composer textarea");
	if (!box) return false;
	box.focus();
	const a = Number.isInteger(box.selectionStart) ? box.selectionStart : box.value.length;
	const b = Number.isInteger(box.selectionEnd) ? box.selectionEnd : a;
	box.setRangeText(text, a, b, "end");
	box.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}
function focusComposer() {
	const box = document.querySelector(".composer textarea");
	if (!box) return false;
	box.focus();
	return true;
}
//#endregion
//#region web/ui/history.js
var KEY$2 = "gf.history";
var MAX = 80;
var SETTLE = 400;
var GIVE_UP = 2e3;
var started = false;
var cur$1 = null;
var here = "#/";
var pending = null;
var store$1 = /* @__PURE__ */ new Map();
var restoring = null;
var saveTimer = 0;
var subs$2 = /* @__PURE__ */ new Set();
var route = (to) => "/" + String(to ?? "").replace(/^#?\/?/, "");
var newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
var stampOf = () => {
	try {
		const s = history.state?.gfEntry;
		return s?.id ? s : null;
	} catch {
		return null;
	}
};
function stamp(st) {
	try {
		history.replaceState({
			...history.state || {},
			gfEntry: st
		}, "");
	} catch {}
}
function rec(id) {
	let r = store$1.get(id);
	if (!r) {
		r = {
			scroll: {},
			state: {}
		};
		store$1.set(id, r);
		while (store$1.size > MAX) store$1.delete(store$1.keys().next().value);
	}
	return r;
}
function flush() {
	clearTimeout(saveTimer);
	saveTimer = 0;
	try {
		sessionStorage.setItem(KEY$2, JSON.stringify([...store$1]));
	} catch {}
}
var saveSoon = () => {
	if (!saveTimer) saveTimer = setTimeout(flush, 300);
};
var nameOf = (el) => el?.classList?.contains("main") ? "main" : el?.dataset?.keepScroll || null;
function where$1(el) {
	const max = el.scrollHeight - el.clientHeight;
	return {
		top: Math.round(el.scrollTop),
		end: max > 2 && max - el.scrollTop < 2
	};
}
function onScroll(e) {
	const el = e.target;
	const name = nameOf(el);
	if (!name || !cur$1) return;
	rec(cur$1.id).scroll[name] = where$1(el);
	saveSoon();
}
var stopRestore = () => {
	restoring = null;
};
function restore(want) {
	const token = {};
	restoring = token;
	const t0 = performance.now();
	const met = {};
	const targets = {
		main: { top: 0 },
		...want
	};
	const step = () => {
		if (restoring !== token) return;
		const now = performance.now();
		const els = { main: document.querySelector(".main") };
		for (const el of document.querySelectorAll("[data-keep-scroll]")) els[el.dataset.keepScroll] = el;
		let waiting = false;
		for (const [name, w] of Object.entries(targets)) {
			const el = els[name];
			if (!el) {
				waiting = true;
				continue;
			}
			const max = el.scrollHeight - el.clientHeight;
			const top = w.end ? max : w.top;
			if (max >= w.top - 1) {
				if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
				met[name] ??= now;
				if (now - met[name] < SETTLE) waiting = true;
			} else if (now - t0 >= GIVE_UP) el.scrollTop = max;
			else waiting = true;
		}
		if (waiting && now - t0 < GIVE_UP) {
			requestAnimationFrame(step);
			return;
		}
		restoring = null;
		if (!cur$1) return;
		for (const name of Object.keys(targets)) if (els[name]) rec(cur$1.id).scroll[name] = where$1(els[name]);
		saveSoon();
	};
	requestAnimationFrame(step);
}
function startHistory() {
	if (started || typeof window === "undefined") return;
	started = true;
	try {
		history.scrollRestoration = "manual";
	} catch {}
	try {
		store$1 = new Map(JSON.parse(sessionStorage.getItem(KEY$2) || "[]"));
	} catch {
		store$1 = /* @__PURE__ */ new Map();
	}
	cur$1 = stampOf();
	if (!cur$1) {
		cur$1 = {
			id: newId(),
			from: null
		};
		stamp(cur$1);
	}
	here = location.hash || "#/";
	addEventListener("scroll", onScroll, true);
	for (const ev of [
		"wheel",
		"touchstart",
		"pointerdown",
		"keydown"
	]) addEventListener(ev, stopRestore, true);
	addEventListener("pagehide", flush);
	restore({ ...store$1.get(cur$1.id)?.scroll || {} });
}
function arrive() {
	if (!started) return startHistory();
	if ((location.hash || "#/") === here) return;
	const st = stampOf();
	if (st) cur$1 = st;
	else {
		cur$1 = {
			id: newId(),
			from: here
		};
		stamp(cur$1);
	}
	const fresh = cur$1.id === pending;
	pending = null;
	here = location.hash || "#/";
	for (const f of subs$2) f();
	restore(fresh ? {} : { ...store$1.get(cur$1.id)?.scroll || {} });
}
function go$1(to, { replace = false } = {}) {
	startHistory();
	const h = "#" + route(to);
	if (h === (location.hash || "#/")) return;
	const now = stampOf() || cur$1;
	const st = {
		id: newId(),
		from: replace ? now?.from ?? null : location.hash || "#/"
	};
	if (replace) location.replace(h);
	else location.hash = h;
	stamp(st);
	pending = st.id;
}
function backTo(parent) {
	const from = (stampOf() || cur$1)?.from;
	return route(from != null ? from : parent);
}
function back(parent) {
	startHistory();
	if ((stampOf() || cur$1)?.from != null) history.back();
	else go$1(parent, { replace: true });
}
function kept$2(key, initial) {
	const v = cur$1 ? store$1.get(cur$1.id)?.state?.[key] : void 0;
	return v === void 0 ? initial : v;
}
function setKept(key, value) {
	if (!cur$1) return;
	rec(cur$1.id).state[key] = value;
	saveSoon();
}
function onEntry(f) {
	subs$2.add(f);
	return () => subs$2.delete(f);
}
//#endregion
//#region web/ui/shell.jsx
function sharedRoute(hash) {
	const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
	if (parts[0] === "p" && parts[1]) {
		const session = parts[2] === "s" ? parts[3] : null, tool = parts[session ? 4 : 2];
		return {
			view: "project",
			project: parts[1],
			session,
			tool: tool === "term" || tool === "edit" ? tool : null
		};
	}
	if (parts[0] === "map") return { view: "map" };
	if (!parts[0]) return { view: "home" };
	return null;
}
function useHashRoute(parse, canonical = (h) => h) {
	const read = () => {
		const h = canonical(location.hash || "#/");
		if (location.hash && h !== location.hash) history.replaceState(history.state, "", h);
		startHistory();
		return parse(h);
	};
	const [r, setR] = d(read);
	const [first] = d(() => location.hash);
	h(() => {
		const f = () => {
			const v = read();
			arrive();
			setR(v);
		};
		addEventListener("hashchange", f);
		if (location.hash !== first) f();
		return () => removeEventListener("hashchange", f);
	}, []);
	return r;
}
var needOf = (projects) => (projects || []).reduce((n, p) => n + p.counts.need_you, 0);
function NavLink({ to, active, onClick, children }) {
	return /* @__PURE__ */ u("a", {
		href: `#${to}`,
		class: `nav${active ? " on" : ""}`,
		onClick,
		children
	});
}
var hostGroups = (list, hosts) => hosts && hosts.length > 1 ? hosts.map((h) => ({
	h,
	items: list.filter((p) => (p.host_key || "") === (h.self ? "" : h.key))
})) : [{
	h: null,
	items: list
}];
var hostDown = (h) => !h.self && h.online === false;
var profOf = (p) => p.profile || "work";
var profileGroups = (items, order = []) => {
	const names = [.../* @__PURE__ */ new Set([...order, ...items.map(profOf)])].filter((n) => items.some((p) => profOf(p) === n));
	return names.length > 1 ? names.map((n) => ({
		n,
		items: items.filter((p) => profOf(p) === n)
	})) : [{
		n: null,
		items
	}];
};
function Sidebar({ name, sub, route, projects, hosts, open, onClose, nav, below, foot }) {
	const [q, setQ] = d("");
	const list = (projects || []).filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.counts.need_you - a.counts.need_you || b.counts.total - a.counts.total || a.name.localeCompare(b.name));
	const groups = hostGroups(list, hosts);
	const profOrder = (projects || []).map(profOf);
	const need = needOf(projects);
	return /* @__PURE__ */ u("nav", {
		class: `side${open ? " open" : ""}`,
		"aria-label": t("nav.label"),
		children: [
			/* @__PURE__ */ u("div", {
				class: "brand",
				children: [/* @__PURE__ */ u(Logo, {}), /* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("b", { children: name }), /* @__PURE__ */ u("small", { children: sub })] })]
			}),
			/* @__PURE__ */ u(NavLink, {
				to: "/",
				active: route.view === "home",
				onClick: onClose,
				children: [
					/* @__PURE__ */ u(Icon, { name: "home" }),
					" ",
					t("nav.home"),
					" ",
					need ? /* @__PURE__ */ u("span", {
						class: "badge need",
						children: need
					}) : null
				]
			}),
			/* @__PURE__ */ u(NavLink, {
				to: "/map",
				active: route.view === "map",
				onClick: onClose,
				children: [
					/* @__PURE__ */ u(Icon, { name: "map" }),
					" ",
					t("nav.map")
				]
			}),
			nav ? nav(onClose) : null,
			/* @__PURE__ */ u("div", {
				class: "side-sec",
				children: [/* @__PURE__ */ u("span", { children: t("nav.projects") }), /* @__PURE__ */ u("input", {
					class: "search",
					placeholder: t("nav.search"),
					value: q,
					onInput: (e) => setQ(e.currentTarget.value),
					"aria-label": t("nav.searchProject"),
					onKeyDown: (e) => {
						if (e.isComposing || e.keyCode === 229) return;
						if (e.key === "Escape") {
							e.preventDefault();
							setQ("");
							e.currentTarget.blur();
							if (open) onClose();
						} else if (e.key === "Enter" && list[0]) {
							e.preventDefault();
							go$1(`/p/${encodeURIComponent(list[0].name)}`);
							e.currentTarget.blur();
							if (open) onClose();
						}
					}
				})]
			}),
			/* @__PURE__ */ u("div", {
				class: "side-list",
				children: [projects == null ? /* @__PURE__ */ u("p", {
					class: "muted pad",
					children: t("common.loading")
				}) : null, groups.map(({ h, items }) => /* @__PURE__ */ u(S$1, { children: [h ? /* @__PURE__ */ u("div", {
					class: `side-host${hostDown(h) ? " down" : ""}`,
					children: [
						/* @__PURE__ */ u(Led, {
							state: hostDown(h) ? "off" : "idle",
							size: 8
						}),
						/* @__PURE__ */ u("span", {
							class: "grow ellipsis",
							children: h.label || h.key
						}),
						hostDown(h) ? /* @__PURE__ */ u("small", { children: t("settings.hostOffline") }) : h.self ? /* @__PURE__ */ u("small", { children: t("settings.hostThis") }) : null
					]
				}) : null, profileGroups(items, profOrder).map(({ n, items: mine }) => /* @__PURE__ */ u(S$1, { children: [n ? /* @__PURE__ */ u("div", {
					class: "side-prof",
					children: [/* @__PURE__ */ u("span", {
						class: "grow ellipsis",
						children: n
					}), needOf(mine) ? /* @__PURE__ */ u("span", {
						class: "badge need",
						children: needOf(mine)
					}) : null]
				}) : null, mine.map((p) => /* @__PURE__ */ u(NavLink, {
					to: `/p/${encodeURIComponent(p.name)}`,
					active: route.view === "project" && route.project === p.name,
					onClick: onClose,
					children: [
						/* @__PURE__ */ u(Led, {
							state: topLight(p.sessions.map((x) => x.status)),
							size: 8
						}),
						/* @__PURE__ */ u("span", {
							class: "grow ellipsis",
							children: h ? p.name.replace(/@[^@]+$/, "") : p.name
						}),
						p.counts.need_you ? /* @__PURE__ */ u("span", {
							class: "badge need",
							children: p.counts.need_you
						}) : p.counts.total ? /* @__PURE__ */ u("span", {
							class: "n",
							children: p.counts.total
						}) : null
					]
				}, p.name))] }, n || "one"))] }, h ? `h:${h.key}` : "all"))]
			}),
			below,
			foot ? foot(onClose) : null
		]
	});
}
function Frame({ name, sub, title = name, route, projects, hosts, nav, below, foot, topEnd, banner, after, settings, class: extra = "", children }) {
	const [menu, setMenu] = d(false);
	const need = needOf(projects);
	h(() => {
		document.title = need ? `(${need}) ${title}` : title;
	}, [need, title]);
	const close = () => setMenu(false), open = () => setMenu(true);
	return /* @__PURE__ */ u("div", {
		class: `app${extra}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "topbar",
				children: [
					/* @__PURE__ */ u("button", {
						class: "icon-btn",
						"aria-label": t("nav.menu"),
						onClick: open,
						children: /* @__PURE__ */ u(Icon, { name: "menu" })
					}),
					/* @__PURE__ */ u("div", {
						class: "brand",
						children: [/* @__PURE__ */ u(Logo, { size: 22 }), /* @__PURE__ */ u("b", { children: name })]
					}),
					/* @__PURE__ */ u("span", {
						class: "topbar-end",
						children: [topEnd ? topEnd(open) : null, need ? /* @__PURE__ */ u("a", {
							class: "badge need",
							href: "#/",
							children: need
						}) : null]
					})
				]
			}),
			menu ? /* @__PURE__ */ u("div", {
				class: "side-scrim",
				onClick: close
			}) : null,
			/* @__PURE__ */ u(Sidebar, {
				name,
				sub,
				route,
				projects,
				hosts,
				open: menu,
				onClose: close,
				nav,
				below,
				foot
			}),
			/* @__PURE__ */ u("main", {
				class: "main",
				children: [banner, children]
			}),
			after,
			/* @__PURE__ */ u(DeskKeys, {
				route,
				projects,
				settings,
				openMenu: open
			}),
			/* @__PURE__ */ u(Toasts, {})
		]
	});
}
//#endregion
//#region web/ui/back.jsx
function useEntry() {
	const [, tick] = d(0);
	h(() => onEntry(() => tick((n) => n + 1)), []);
}
function useKept(key, initial) {
	const [v, setV] = d(() => kept$2(key, initial));
	h(() => onEntry(() => setV(kept$2(key, initial))), [key]);
	const set = (x) => setV((prev) => {
		const n = typeof x === "function" ? x(prev) : x;
		setKept(key, n);
		return n;
	});
	return [v, set];
}
var SHARED_PLACES = {
	activity: "nav.activity",
	settings: "nav.settings"
};
function placeName(to, own) {
	let parts;
	try {
		parts = String(to).replace(/^#?\/?/, "").split("/").map(decodeURIComponent);
	} catch {
		parts = [];
	}
	if (parts[0] === "p" && parts[1]) return parts[2] === "s" && parts[3] ? parts[3] : parts[1];
	if (parts[0] === "map") return t("nav.map");
	if (!parts[0]) return t("nav.home");
	if (SHARED_PLACES[parts[0]]) return t(SHARED_PLACES[parts[0]]);
	return own?.(to) || t("common.back");
}
function BackLink({ parent, class: extra = "" }) {
	useEntry();
	const fleet = useFleet();
	const to = backTo(parent);
	const place = placeName(to, fleet?.place);
	return /* @__PURE__ */ u("a", {
		class: `back-link${extra ? ` ${extra}` : ""}`,
		href: `#${to}`,
		"aria-label": t("common.backTo", { place }),
		onClick: (e) => {
			if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			back(parent);
		},
		children: [
			/* @__PURE__ */ u("span", {
				"aria-hidden": "true",
				children: "←"
			}),
			" ",
			place
		]
	});
}
//#endregion
//#region web/ui/select.jsx
function Portal({ children }) {
	const host = A(null);
	if (!host.current) host.current = document.createElement("div");
	_(() => {
		document.body.append(host.current);
		return () => {
			R(null, host.current);
			host.current.remove();
		};
	}, []);
	_(() => {
		R(children, host.current);
	});
	return null;
}
var stack = [];
function onPress(e) {
	for (let i = stack.length - 1; i >= 0; i--) {
		if (stack[i].contains(e.target)) break;
		stack[i].close(false);
	}
}
function onEsc(e) {
	if (e.key !== "Escape" || e.isComposing || !stack.length) return;
	e.preventDefault();
	e.stopPropagation();
	stack[stack.length - 1].close(true);
}
function useLayer(open, contains, close) {
	const me = A({});
	me.current.contains = contains;
	me.current.close = close;
	h(() => {
		if (!open) return void 0;
		const layer = {
			contains: (n) => !!me.current.contains(n),
			close: (f) => me.current.close(f)
		};
		stack.push(layer);
		if (stack.length === 1) {
			document.addEventListener("pointerdown", onPress, true);
			addEventListener("keydown", onEsc, true);
		}
		return () => {
			const i = stack.indexOf(layer);
			if (i >= 0) stack.splice(i, 1);
			if (!stack.length) {
				document.removeEventListener("pointerdown", onPress, true);
				removeEventListener("keydown", onEsc, true);
			}
		};
	}, [open]);
}
function useFollow(open, place, inside) {
	_(() => {
		if (!open) return void 0;
		place();
		const on = (e) => {
			if (!(e.type === "scroll" && inside(e.target))) place();
		};
		addEventListener("scroll", on, true);
		addEventListener("resize", on);
		return () => {
			removeEventListener("scroll", on, true);
			removeEventListener("resize", on);
		};
	}, [open]);
}
var EDGE$1 = 8;
var GAP = 4;
function placeBy(anchor, box, { maxH = 320, align = "start", minWidth = 0, maxW = Infinity, prefer = "down" } = {}) {
	const r = anchor.getBoundingClientRect();
	const vw = document.documentElement.clientWidth, vh = innerHeight;
	const keep = box.scrollTop;
	box.style.maxWidth = `${Math.min(maxW, vw - 16)}px`;
	box.style.minWidth = `${Math.min(minWidth, vw - 16)}px`;
	box.style.maxHeight = "none";
	const full = box.offsetHeight;
	const below = vh - r.bottom - GAP - EDGE$1, above = r.top - GAP - EDGE$1;
	const up = prefer === "up" ? !(full > above && below > above) : full > below && above > below;
	const h = Math.min(full, maxH, Math.max(0, up ? above : below));
	box.style.maxHeight = `${h}px`;
	box.style.top = `${up ? r.top - GAP - h : r.bottom + GAP}px`;
	const w = box.offsetWidth;
	let left = align === "end" ? r.right - w : align === "center" ? r.left + (r.width - w) / 2 : r.left;
	left = Math.max(EDGE$1, Math.min(left, vw - EDGE$1 - w));
	box.style.left = `${left}px`;
	box.scrollTop = keep;
	return up ? "up" : "down";
}
var fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
var same = (a, b) => String(a) === String(b);
function Select({ value, onChange, options, label, labelClass, field = "field", placeholder = "", class: cls = "", disabled, title, "aria-label": ariaLabel }) {
	const id = g();
	const [open, setOpen] = d(false);
	const [active, setActive] = d(-1);
	const btn = A(null), list = A(null), typed = A({
		s: "",
		at: 0
	});
	const chosen = options.findIndex((o) => same(o.value, value));
	const cur = options[chosen];
	const last = options.length - 1;
	const show = (i) => {
		setActive(Math.max(0, Math.min(i, last)));
		setOpen(true);
	};
	const close = (focus) => {
		setOpen(false);
		typed.current = {
			s: "",
			at: 0
		};
		if (focus) btn.current?.focus({ preventScroll: true });
	};
	const pick = (i) => {
		const o = options[i];
		close(true);
		if (o && !same(o.value, value)) onChange(o.value);
	};
	const lab = A(null);
	useLayer(open, (n) => btn.current?.contains(n) || list.current?.contains(n) || lab.current?.contains(n), close);
	useFollow(open, () => {
		if (btn.current && list.current) {
			list.current.style.fontSize = getComputedStyle(btn.current).fontSize;
			placeBy(btn.current, list.current, { minWidth: btn.current.offsetWidth });
		}
	}, (n) => list.current?.contains(n));
	_(() => {
		const l = list.current, o = l?.children[active];
		if (!o) return;
		if (o.offsetTop < l.scrollTop) l.scrollTop = o.offsetTop - 5;
		else if (o.offsetTop + o.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = o.offsetTop + o.offsetHeight - l.clientHeight + 5;
	}, [open, active]);
	const search = (ch, from) => {
		const T = typed.current, now = Date.now();
		T.s = now - T.at < 700 ? T.s + ch : ch;
		T.at = now;
		const again = [...T.s].every((c) => c === T.s[0]);
		const q = fold(again ? T.s[0] : T.s);
		const n = options.length, start = again ? from + 1 : from;
		for (let k = 0; k < n; k++) {
			const i = ((start + k) % n + n) % n;
			if (fold(options[i].label).startsWith(q)) return i;
		}
		return -1;
	};
	const typing = () => Date.now() - typed.current.at < 700 && typed.current.s;
	const onKey = (e) => {
		if (e.metaKey || e.ctrlKey || e.isComposing) return;
		const k = e.key;
		const letter = k.length === 1 && k !== " " && !e.altKey;
		let next = null;
		if (!open) {
			if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") next = Math.max(chosen, 0);
			else if (k === "Home") next = 0;
			else if (k === "End") next = last;
			else if (letter) {
				const i = search(k, chosen);
				next = i < 0 ? Math.max(chosen, 0) : i;
			} else return;
			e.preventDefault();
			e.stopPropagation();
			show(next);
			return;
		}
		if (k === "Tab") {
			close(false);
			return;
		}
		if (e.altKey && k === "ArrowUp") next = "pick";
		else if (k === "Enter" || k === " " && !typing()) next = "pick";
		else if (k === "ArrowDown") next = Math.min(active + 1, last);
		else if (k === "ArrowUp") next = Math.max(active - 1, 0);
		else if (k === "Home") next = 0;
		else if (k === "End") next = last;
		else if (k === "PageDown") next = Math.min(active + 10, last);
		else if (k === "PageUp") next = Math.max(active - 10, 0);
		else if (letter || k === " ") {
			const i = search(k, active);
			next = i < 0 ? active : i;
		} else return;
		e.preventDefault();
		e.stopPropagation();
		if (next === "pick") pick(active);
		else setActive(next);
	};
	const lid = `${id}-l`, listId = `${id}-x`, optId = (i) => `${id}-o${i}`;
	const named = label != null ? { "aria-labelledby": lid } : { "aria-label": ariaLabel };
	const button = /* @__PURE__ */ u("button", {
		type: "button",
		ref: btn,
		class: `select${cls ? ` ${cls}` : ""}`,
		role: "combobox",
		"aria-haspopup": "listbox",
		"aria-expanded": open,
		"aria-controls": open ? listId : void 0,
		"aria-activedescendant": open && active >= 0 ? optId(active) : void 0,
		...named,
		disabled,
		title,
		onClick: () => open ? close(false) : show(Math.max(chosen, 0)),
		onKeyDown: onKey,
		children: [cur?.icon ?? null, /* @__PURE__ */ u("span", {
			class: "select-v",
			children: cur ? cur.label : placeholder
		})]
	});
	const box = open ? /* @__PURE__ */ u(Portal, { children: /* @__PURE__ */ u("div", {
		class: "menu select-list",
		id: listId,
		role: "listbox",
		ref: list,
		...named,
		children: options.map((o, i) => /* @__PURE__ */ u("div", {
			id: optId(i),
			role: "option",
			"aria-selected": i === chosen,
			class: `select-opt${i === active ? " on" : ""}`,
			onMouseDown: (e) => e.preventDefault(),
			onMouseMove: () => {
				if (i !== active) setActive(i);
			},
			onClick: () => pick(i),
			children: [
				o.icon ?? null,
				/* @__PURE__ */ u("span", {
					class: "select-v",
					children: o.label
				}),
				i === chosen ? /* @__PURE__ */ u(Icon, { name: "check" }) : null
			]
		}, String(o.value)))
	}) }) : null;
	if (label == null) return /* @__PURE__ */ u(S$1, { children: [button, box] });
	return /* @__PURE__ */ u("div", {
		class: field,
		children: [
			/* @__PURE__ */ u("span", {
				id: lid,
				ref: lab,
				class: `select-label${labelClass ? ` ${labelClass}` : ""}`,
				onClick: () => {
					btn.current?.focus({ preventScroll: true });
					btn.current?.click();
				},
				children: label
			}),
			button,
			box
		]
	});
}
function Popover({ label, icon, class: cls = "", boxClass = "", title, children }) {
	const id = g();
	const [open, setOpen] = d(false);
	const btn = A(null), box = A(null), fromKeys = A(false);
	const close = (focus) => {
		setOpen(false);
		if (focus) btn.current?.focus({ preventScroll: true });
	};
	useLayer(open, (n) => btn.current?.contains(n) || box.current?.contains(n), close);
	useFollow(open, () => {
		if (btn.current && box.current) placeBy(btn.current, box.current, { maxH: 520 });
	}, (n) => box.current?.contains(n));
	h(() => {
		if (open && fromKeys.current) box.current?.querySelector("button, input, [tabindex]:not([tabindex=\"-1\"])")?.focus({ preventScroll: true });
	}, [open]);
	const toggle = (e) => {
		if (open) {
			close(false);
			return;
		}
		fromKeys.current = e.detail === 0;
		setOpen(true);
	};
	const leave = (e) => {
		const to = e.relatedTarget;
		if (open && to && !btn.current?.contains(to) && !box.current?.contains(to)) close(false);
	};
	return /* @__PURE__ */ u("div", {
		class: "pop",
		onFocusOut: leave,
		children: [/* @__PURE__ */ u("button", {
			type: "button",
			ref: btn,
			class: cls,
			"aria-haspopup": "dialog",
			"aria-expanded": open,
			"aria-controls": open ? id : void 0,
			onClick: toggle,
			children: [icon ? /* @__PURE__ */ u(Icon, { name: icon }) : null, label]
		}), open ? /* @__PURE__ */ u("div", {
			class: `menu popover${boxClass ? ` ${boxClass}` : ""}`,
			id,
			ref: box,
			role: "dialog",
			"aria-label": title || void 0,
			children
		}) : null]
	});
}
//#endregion
//#region web/ui/shiptip.jsx
var HOVER_MS = 150;
var PRESS_MS = 500;
var SWAP_MS = 300;
var CROSS_MS = 150;
var SLOP = 10;
var KEEP_MS = 1e4;
var grids = /* @__PURE__ */ new Map();
function gridOf(fleet, project) {
	const g = grids.get(project);
	if (g && (g.wait || Date.now() - g.at < KEEP_MS)) return g;
	const n = {
		at: 0,
		data: g?.data || null,
		wait: null
	};
	n.wait = Promise.resolve().then(() => fleet.grid(project)).then((d) => {
		n.data = d;
	}, () => {}).then(() => {
		n.at = Date.now();
		n.wait = null;
	});
	grids.set(project, n);
	return n;
}
var cardOf = (project, name) => grids.get(project)?.data?.cards?.find((c) => c.name === name) || null;
var agentOf = (c) => c?.agent ? c.model ? `${c.agent} · ${c.model}` : c.agent : null;
var keyboard = (el) => !document.documentElement.classList.contains("by-pointer") && el.matches(":focus-visible");
function useShipTips() {
	const fleet = useFleet();
	const ownerName = useSlot("ownerName"), ownerBadge = useSlot("ownerBadge");
	const [tip, setTip] = d(null);
	const [, landed] = d(0);
	const id = g();
	const box = A(null);
	const m = A(null);
	if (!m.current) m.current = {
		infos: /* @__PURE__ */ new Map(),
		els: /* @__PURE__ */ new Map(),
		timer: 0,
		cross: 0,
		shut: 0,
		press: null,
		ate: false,
		xy: null,
		still: null
	};
	const s = m.current;
	s.tip = tip;
	const warm = (project) => {
		const g = gridOf(fleet, project);
		if (g.wait) g.wait.then(() => landed((n) => n + 1));
	};
	const open = (key, how) => {
		clearTimeout(s.timer);
		clearTimeout(s.cross);
		setTip({
			key,
			how
		});
	};
	const close = (esc) => {
		clearTimeout(s.timer);
		clearTimeout(s.cross);
		if (!s.tip) return;
		s.shut = Date.now();
		if (esc) s.still = s.xy;
		s.tip = null;
		setTip(null);
	};
	const leave = () => {
		clearTimeout(s.cross);
		s.cross = setTimeout(() => close(false), CROSS_MS);
	};
	useLayer(!!tip, (n) => !!(box.current?.contains(n) || s.tip && s.els.get(s.tip.key)?.contains(n)), (esc) => close(esc));
	const place = () => {
		const el = s.tip && s.els.get(s.tip.key), b = box.current;
		if (!el || !el.isConnected) {
			close(false);
			return;
		}
		if (!b) return;
		const others = [...s.els.values()].filter((x) => x !== el && x.isConnected).map((x) => x.getBoundingClientRect());
		const cover = () => {
			const r = b.getBoundingClientRect();
			return others.reduce((n, o) => n + Math.max(0, Math.min(r.right, o.right) - Math.max(r.left, o.left)) * Math.max(0, Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)), 0);
		};
		const at = (prefer) => placeBy(el, b, {
			prefer,
			align: "center",
			maxW: 300,
			maxH: 360
		});
		at("up");
		const up = cover();
		if (!up) return;
		at("down");
		if (cover() >= up) at("up");
	};
	_(() => {
		if (tip) place();
	});
	h(() => {
		if (!tip) return void 0;
		const on = (e) => {
			if (!(e.type === "scroll" && box.current?.contains(e.target))) place();
		};
		const xy = (e) => {
			s.xy = {
				x: e.clientX,
				y: e.clientY
			};
		};
		addEventListener("scroll", on, true);
		addEventListener("resize", on);
		addEventListener("pointermove", xy, { passive: true });
		return () => {
			removeEventListener("scroll", on, true);
			removeEventListener("resize", on);
			removeEventListener("pointermove", xy);
		};
	}, [tip?.key]);
	h(() => () => clearTimeout(s.timer), []);
	const facts = (info) => {
		const owner = ownerName(info.session), ago = sinceTs(info.ts), agent = agentOf(cardOf(info.project, info.name));
		return [
			`${info.lead ? t("common.lead") : info.name}, ${info.project}`,
			info.word,
			agent,
			owner ? `${t("tip.owner")}: ${owner}` : null,
			ago ? `${t("tip.moved")} ${ago}` : null
		].filter(Boolean).join(" · ");
	};
	const bind = (info, onClick) => {
		const key = `${info.project}/${info.name}`;
		s.infos.set(key, info);
		return {
			ref: (el) => {
				if (el) s.els.set(key, el);
				else if (!s.els.get(key)?.isConnected) s.els.delete(key);
			},
			"aria-label": facts(info),
			"aria-describedby": tip?.key === key ? id : void 0,
			onPointerEnter: (e) => {
				if (e.pointerType === "touch") return;
				warm(info.project);
				if (s.still && e.clientX === s.still.x && e.clientY === s.still.y) return;
				s.still = null;
				clearTimeout(s.timer);
				clearTimeout(s.cross);
				if (s.tip?.key === key) return;
				if (s.tip || Date.now() - s.shut < SWAP_MS) open(key, "hover");
				else s.timer = setTimeout(() => open(key, "hover"), HOVER_MS);
			},
			onPointerLeave: (e) => {
				if (e.pointerType === "touch") return;
				clearTimeout(s.timer);
				if (s.tip?.key === key && s.tip.how === "hover") leave();
			},
			onFocus: (e) => {
				if (keyboard(e.currentTarget)) {
					warm(info.project);
					open(key, "focus");
				}
			},
			onBlur: () => {
				if (s.tip?.key === key && s.tip.how === "focus") close(false);
			},
			onPointerDown: (e) => {
				s.ate = false;
				if (e.pointerType !== "touch") return;
				warm(info.project);
				s.press = {
					x: e.clientX,
					y: e.clientY
				};
				clearTimeout(s.timer);
				s.timer = setTimeout(() => {
					s.press = null;
					s.ate = true;
					open(key, "press");
				}, PRESS_MS);
			},
			onPointerMove: (e) => {
				if (s.press && Math.hypot(e.clientX - s.press.x, e.clientY - s.press.y) > SLOP) {
					clearTimeout(s.timer);
					s.press = null;
				}
			},
			onPointerUp: () => {
				if (s.press) {
					clearTimeout(s.timer);
					s.press = null;
				}
			},
			onPointerCancel: () => {
				if (s.press) {
					clearTimeout(s.timer);
					s.press = null;
				}
			},
			onContextMenu: (e) => {
				if (s.ate || s.press) e.preventDefault();
			},
			onClick: (e) => {
				if (s.ate) {
					s.ate = false;
					e.preventDefault();
					return;
				}
				onClick?.(e);
			}
		};
	};
	const info = tip && s.infos.get(tip.key);
	return {
		bind,
		card: info ? /* @__PURE__ */ u(Portal, { children: /* @__PURE__ */ u(ShipCard, {
			id,
			box,
			info,
			card: cardOf(info.project, info.name),
			owner: ownerName(info.session),
			badge: ownerBadge(info.session, 18),
			onEnter: () => clearTimeout(s.cross),
			onLeave: () => {
				if (s.tip?.how === "hover") leave();
			}
		}) }) : null,
		warm
	};
}
function ShipCard({ id, box, info, card, owner, badge, onEnter, onLeave }) {
	const ago = sinceTs(info.ts), agent = agentOf(card);
	const rows = [
		agent ? [
			"agent",
			t("tip.agent"),
			agent
		] : null,
		owner ? [
			"owner",
			t("tip.owner"),
			/* @__PURE__ */ u(S$1, { children: [badge, /* @__PURE__ */ u("span", { children: owner })] })
		] : null,
		card?.label ? [
			"label",
			t("tip.label"),
			card.label
		] : null,
		ago ? [
			"moved",
			t("tip.moved"),
			ago
		] : null,
		card?.msg ? [
			"said",
			t("tip.said"),
			/* @__PURE__ */ u("span", {
				class: "tip-said",
				children: card.msg
			})
		] : null
	].filter(Boolean);
	return /* @__PURE__ */ u("div", {
		id,
		role: "tooltip",
		ref: box,
		class: "menu popover ship-tip",
		onPointerEnter: onEnter,
		onPointerLeave: onLeave,
		children: [
			/* @__PURE__ */ u("p", {
				class: "tip-who",
				children: [
					/* @__PURE__ */ u("b", { children: info.lead ? t("common.lead") : info.name }),
					" ",
					/* @__PURE__ */ u("span", { children: info.project })
				]
			}),
			/* @__PURE__ */ u("p", {
				class: "tip-state",
				children: [
					/* @__PURE__ */ u(Led, {
						state: info.light,
						hidden: true
					}),
					" ",
					info.word
				]
			}),
			rows.length ? /* @__PURE__ */ u("dl", {
				class: "tip-rows",
				children: rows.map(([k, dt, dd]) => /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("dt", { children: dt }), /* @__PURE__ */ u("dd", {
					class: `tip-${k}`,
					children: dd
				})] }, k))
			}) : null
		]
	});
}
//#endregion
//#region web/ui/board.jsx
var FRESH_S = 900;
var LOOKS = worded({
	need: {
		color: "yellow",
		light: "wait"
	},
	work: {
		color: "green",
		light: "work"
	},
	fresh: {
		color: "cyan",
		light: "done"
	},
	warn: {
		color: "red",
		light: "error"
	},
	open: {
		color: "white",
		light: "idle"
	},
	off: {
		color: "grey",
		light: "off"
	}
}, "look");
var ORDER = Object.keys(LOOKS);
function lookOf(s, now = Date.now() / 1e3) {
	switch (s.status) {
		case "need-you": return "need";
		case "working":
		case "starting": return "work";
		case "ready": return s.ts && now - s.ts < FRESH_S ? "fresh" : "open";
		case "limit":
		case "interrupted":
		case "unknown": return "warn";
		case "idle": return "open";
		default: return "off";
	}
}
var sessionHref = (p, s) => `#/p/${encodeURIComponent(p)}/s/${encodeURIComponent(s)}`;
var projectHref = (p) => `#/p/${encodeURIComponent(p)}`;
function Board({ projects }) {
	const ownerBadge = useSlot("ownerBadge");
	const tips = useShipTips();
	const [showQuiet, setShowQuiet] = useKept("board.quiet", false);
	const now = Date.now() / 1e3;
	const fleets = (projects || []).map((p) => {
		const boats = p.sessions.map((s) => ({
			...s,
			look: lookOf(s, now)
		})).sort((a, b) => ORDER.indexOf(a.look) - ORDER.indexOf(b.look) || Number(b.lead) - Number(a.lead));
		const n = Object.fromEntries(ORDER.map((k) => [k, boats.filter((b) => b.look === k).length]));
		const top = ORDER.find((k) => n[k]) || "off";
		const last = Math.max(0, ...p.sessions.map((s) => s.ts || 0));
		return {
			name: p.name,
			boats,
			n,
			top,
			last
		};
	});
	const live = fleets.filter((f) => f.top !== "off").sort((a, b) => ORDER.indexOf(a.top) - ORDER.indexOf(b.top) || b.n.need - a.n.need || b.n.work - a.n.work || b.last - a.last);
	const quiet = fleets.filter((f) => f.top === "off").sort((a, b) => b.boats.length - a.boats.length || a.name.localeCompare(b.name));
	const total = Object.fromEntries(ORDER.map((k) => [k, fleets.reduce((x, f) => x + f.n[k], 0)]));
	if (projects == null) return /* @__PURE__ */ u("p", {
		class: "muted",
		children: t("map.reading")
	});
	return /* @__PURE__ */ u("section", {
		class: "board",
		children: [
			/* @__PURE__ */ u("div", {
				class: "legend",
				role: "list",
				children: ORDER.filter((k) => total[k]).map((k) => /* @__PURE__ */ u("span", {
					role: "listitem",
					class: `lg c-${LOOKS[k].color} lk-${k}`,
					children: [
						/* @__PURE__ */ u(Led, {
							state: LOOKS[k].light,
							hidden: true
						}),
						total[k],
						" ",
						/* @__PURE__ */ u("small", { children: LOOKS[k].label })
					]
				}, k))
			}),
			live.length ? /* @__PURE__ */ u("div", {
				class: "fleets",
				children: live.map((f) => /* @__PURE__ */ u("article", {
					class: `fleet c-${LOOKS[f.top].color} lk-${f.top}`,
					onPointerEnter: () => tips.warm(f.name),
					children: [/* @__PURE__ */ u("a", {
						class: "fleet-name",
						href: projectHref(f.name),
						title: t("board.open", { name: f.name }),
						children: /* @__PURE__ */ u(ProjectName, { name: f.name })
					}), /* @__PURE__ */ u("div", {
						class: "fleet-sea",
						children: f.boats.map((b) => {
							const badge = ownerBadge(b, 15);
							return /* @__PURE__ */ u("a", {
								class: `fboat c-${LOOKS[b.look].color} lk-${b.look}`,
								href: sessionHref(f.name, b.name),
								...tips.bind({
									project: f.name,
									name: b.name,
									lead: b.lead,
									ts: b.ts,
									session: b,
									word: LOOKS[b.look].label,
									light: LOOKS[b.look].light
								}),
								children: [
									/* @__PURE__ */ u(Ship, {
										size: b.lead ? 64 : 32,
										state: LOOKS[b.look].light
									}),
									b.look === "need" ? /* @__PURE__ */ u("span", {
										class: "fboat-name",
										children: b.lead ? t("common.lead") : b.name
									}) : null,
									badge ? /* @__PURE__ */ u("span", {
										class: "fboat-owner",
										children: badge
									}) : null
								]
							}, b.name);
						})
					})]
				}, f.name))
			}) : /* @__PURE__ */ u("p", {
				class: "muted pad",
				children: t("board.none")
			}),
			tips.card,
			quiet.length ? /* @__PURE__ */ u("div", {
				class: `quiet${showQuiet ? " open" : ""}`,
				children: [/* @__PURE__ */ u("button", {
					class: "quiet-toggle",
					onClick: () => setShowQuiet((v) => !v),
					"aria-expanded": showQuiet,
					children: [
						/* @__PURE__ */ u("i", { class: "qdot" }),
						" ",
						t("board.quiet", { n: quiet.length }),
						" ",
						showQuiet ? "▴" : "▾"
					]
				}), showQuiet ? quiet.map((f) => /* @__PURE__ */ u("a", {
					class: "qchip",
					href: projectHref(f.name),
					children: /* @__PURE__ */ u(ProjectName, { name: f.name })
				}, f.name)) : null]
			}) : null
		]
	});
}
//#endregion
//#region web/ui/home.jsx
var TILES = ".main .fleet-name, .main .qchip";
var projectOf = (el) => {
	const a = el?.closest?.(".fleet")?.querySelector(".fleet-name") || el?.closest?.(".qchip");
	const m = /^#\/p\/([^/]+)/.exec(a?.getAttribute("href") || "");
	return m ? decodeURIComponent(m[1]) : null;
};
function Home({ projects, children }) {
	useKeys((key, e, layer) => {
		const { k, lk, ctrl } = key;
		if (ctrl) {
			if (lk !== "s") return false;
			const p = projectOf(document.activeElement);
			if (p) layer.go(projectTo(p));
			return true;
		}
		const d = dirOf(key);
		if (d) {
			moveFocus(TILES, d);
			return true;
		}
		if (!key.alt && /^[1-9]$/.test(k)) {
			const p = (projects || [])[Number(k) - 1];
			if (p) layer.toLead(p.name);
			return true;
		}
		return false;
	});
	return /* @__PURE__ */ u("div", {
		class: "page home",
		children: [children, /* @__PURE__ */ u(Board, { projects })]
	});
}
//#endregion
//#region \0vite/preload-helper.js
var scriptRel = /* @__PURE__ */ (function detectScriptRel() {
	const relList = typeof document !== "undefined" && document.createElement("link").relList;
	return relList && relList.supports && relList.supports("modulepreload") ? "modulepreload" : "preload";
})();
var assetsURL = function(dep) {
	return "/" + dep;
};
var seen = {};
var __vitePreload = function preload(baseModule, deps, importerUrl) {
	let promise = Promise.resolve();
	if (deps && deps.length > 0) {
		const links = document.getElementsByTagName("link");
		const cspNonceMeta = document.querySelector("meta[property=csp-nonce]");
		const cspNonce = cspNonceMeta?.nonce || cspNonceMeta?.getAttribute("nonce");
		function allSettled(promises) {
			return Promise.all(promises.map((p) => Promise.resolve(p).then((value) => ({
				status: "fulfilled",
				value
			}), (reason) => ({
				status: "rejected",
				reason
			}))));
		}
		function importMetaResolve(specifier) {
			if (import.meta.resolve) return import.meta.resolve(specifier);
			return new URL(
				specifier,
				/** #__KEEP__ */
				import.meta.url
			).href;
		}
		promise = allSettled(deps.map((dep) => {
			dep = assetsURL(dep, importerUrl);
			dep = importMetaResolve(dep);
			if (dep in seen) return;
			seen[dep] = true;
			const isCss = dep.endsWith(".css");
			for (let i = links.length - 1; i >= 0; i--) {
				const link = links[i];
				if (link.href === dep && (!isCss || link.rel === "stylesheet")) return;
			}
			const link = document.createElement("link");
			link.rel = isCss ? "stylesheet" : scriptRel;
			if (!isCss) link.as = "script";
			link.crossOrigin = "";
			link.href = dep;
			if (cspNonce) link.setAttribute("nonce", cspNonce);
			document.head.appendChild(link);
			if (isCss) return new Promise((res, rej) => {
				link.addEventListener("load", res);
				link.addEventListener("error", () => rej(/* @__PURE__ */ new Error(`Unable to preload CSS for ${dep}`)));
			});
		}).filter((p) => p !== void 0));
	}
	function handlePreloadError(err) {
		const e = new Event("vite:preloadError", { cancelable: true });
		e.payload = err;
		window.dispatchEvent(e);
		if (!e.defaultPrevented) throw err;
	}
	return promise.then((res) => {
		for (const item of res || []) {
			if (item.status !== "rejected") continue;
			handlePreloadError(item.reason);
		}
		return baseModule().catch(handlePreloadError);
	});
};
//#endregion
//#region web/ui/terminal.jsx
var TOOL_KINDS = ["term", "edit"];
var baseTo = (project, session) => session ? sessionTo(project, session) : projectTo(project);
var toolTo = (project, session, kind) => `${baseTo(project, session)}/${kind}`;
var refused = /* @__PURE__ */ new Set();
var offers = (fleet, project) => typeof fleet.canTerm === "function" && typeof fleet.termOpen === "function" && typeof fleet.termSocket === "function" && !refused.has(project) && !!fleet.canTerm(project);
function ToolTabs({ project, session, tool }) {
	const fleet = useFleet();
	const on = A(null);
	h(() => {
		const a = on.current, bar = a && a.parentElement;
		if (!bar) return;
		const x = a.getBoundingClientRect(), y = bar.getBoundingClientRect();
		if (x.right > y.right) bar.scrollLeft += x.right - y.right + 16;
		else if (x.left < y.left) bar.scrollLeft -= y.left - x.left + 16;
	}, [tool]);
	if (!offers(fleet, project)) return null;
	return TOOL_KINDS.map((k) => /* @__PURE__ */ u("a", {
		ref: tool === k ? on : null,
		role: "tab",
		class: `tool-tab${tool === k ? " on" : ""}`,
		"aria-selected": tool === k,
		href: `#${toolTo(project, session, k)}`,
		children: t(`term.tab.${k}`)
	}, k));
}
function ProjectTabs({ project, tool }) {
	if (!offers(useFleet(), project)) return null;
	return /* @__PURE__ */ u("div", {
		class: "tabs page-tabs",
		role: "tablist",
		children: [/* @__PURE__ */ u("a", {
			role: "tab",
			class: tool ? "" : "on",
			"aria-selected": !tool,
			href: `#${projectTo(project)}`,
			children: t("term.tab.sessions")
		}), /* @__PURE__ */ u(ToolTabs, {
			project,
			session: null,
			tool
		})]
	});
}
var FONT_KEY = "gfw.termFont";
function startFont(T) {
	if (!T.isTouch()) return 13;
	let v = 0;
	try {
		v = Number(localStorage.getItem(FONT_KEY)) || 0;
	} catch {}
	return v >= T.FONT_MIN && v <= T.FONT_MAX ? v : T.defaultFont();
}
var keepFocus = (e) => e.preventDefault();
function Notice({ n, kind, onAgain, fleet }) {
	const title = {
		idle: t("term.idle", { min: n.min }),
		takeover: t(`term.takeover.${kind}`),
		failed: t("term.failed"),
		dropped: t("term.dropped"),
		ended: t(`term.ended.${kind}`),
		noEditor: t("term.noEditor"),
		password: t("term.password"),
		signedOut: t("term.signedOut"),
		refused: t("term.refused"),
		off: t("term.off")
	}[n.kind] || t("term.failed");
	const why = {
		idle: t("term.idleWhy"),
		takeover: t("term.takeoverWhy"),
		password: t("term.passwordWhy"),
		signedOut: t("term.signedOutWhy"),
		failed: t("term.failedWhy"),
		dropped: t("term.droppedWhy"),
		ended: t("term.endedWhy"),
		off: t("term.offWhy")
	}[n.kind] || n.why || "";
	let act = /* @__PURE__ */ u(Btn, {
		kind: "primary sm",
		onClick: onAgain,
		children: t(n.kind === "idle" || n.kind === "takeover" ? "term.reconnect" : "term.openAgain")
	});
	if (n.kind === "password") act = fleet.changePassword ? /* @__PURE__ */ u(Btn, {
		kind: "primary sm",
		onClick: () => fleet.changePassword(),
		children: t("term.changePassword")
	}) : null;
	if (n.kind === "signedOut") act = fleet.signIn ? /* @__PURE__ */ u(Btn, {
		kind: "primary sm",
		onClick: () => fleet.signIn(),
		children: t("term.signIn")
	}) : null;
	if (n.kind === "off") act = /* @__PURE__ */ u(Btn, {
		kind: "primary sm",
		onClick: () => fleet.go("/settings"),
		children: t("term.openSettings")
	});
	return /* @__PURE__ */ u("div", {
		class: `tool-note n-${n.kind}`,
		role: "status",
		children: [/* @__PURE__ */ u("div", {
			class: "tool-note-text",
			children: [/* @__PURE__ */ u("b", { children: title }), why ? /* @__PURE__ */ u("span", { children: why }) : null]
		}), act]
	});
}
var away = (to) => location.replace(`#${to}`);
function Away({ to }) {
	h(() => {
		away(to);
	}, [to]);
	return null;
}
function ToolPanel(props) {
	if (!offers(useFleet(), props.project)) return /* @__PURE__ */ u(Away, { to: baseTo(props.project, props.session) });
	return /* @__PURE__ */ u(Panel, { ...props });
}
function Panel({ project, session, kind }) {
	const fleet = useFleet();
	const panel = A(null), host = A(null), row = A(null);
	const h$1 = A(null);
	const live = A({
		alive: true,
		hello: false,
		retried: false,
		idle: 1800,
		touch: false
	});
	const [phase, setPhase] = d("loading");
	const [notice, setNotice] = d(null);
	const [focused, setFocused] = d(false);
	const [touch, setTouch] = d(false);
	const [tab, setTab] = d(`_${kind}-${project}`);
	const back = baseTo(project, session);
	const say = (k, why = "") => {
		if (!live.current.alive) return;
		setPhase("closed");
		setNotice({
			kind: k,
			why: String(why || ""),
			min: Math.round(live.current.idle / 60)
		});
	};
	const open = async (silent = false) => {
		const L = live.current;
		if (!h$1.current || !L.alive) return;
		if (!silent) L.retried = false;
		L.hello = false;
		setNotice(null);
		setPhase("opening");
		let r;
		try {
			r = await fleet.termOpen(project, kind, h$1.current.size());
		} catch (e) {
			if (L.alive) await denied(e);
			return;
		}
		if (!L.alive || !h$1.current) return;
		if (r.session) setTab(r.session);
		h$1.current.connect(r.ticket);
	};
	const denied = async (e) => {
		const s = e && e.status;
		if (s === 404) {
			refused.add(project);
			away(back);
			return;
		}
		if (s === 401) return say("signedOut");
		if (s === 403 && e.needs === "enable") return say("off");
		if (s === 403) {
			let who;
			try {
				who = fleet.termAccount ? await fleet.termAccount() : void 0;
			} catch {}
			if (who === null) return say("signedOut");
			return say(who && who.mustChange ? "password" : "refused", e.message);
		}
		if (s === 502 && kind === "edit" && /no editor/i.test(e.message || "")) return say("noEditor", e.message);
		return say("failed", e && e.message || "");
	};
	const onState = ({ state, why, code }) => {
		const L = live.current;
		if (!L.alive) return;
		if (state === "opening") return setPhase("opening");
		if (state === "open") {
			L.retried = false;
			setNotice(null);
			setPhase("open");
			return;
		}
		if (!L.hello) {
			if (!L.retried) {
				L.retried = true;
				open(true);
				return;
			}
			return say("failed", why);
		}
		if (code === 4e3) return say("idle");
		if (code === 4001) return say("takeover");
		if (code === 4003 && !L.retried) {
			L.retried = true;
			open(true);
			return;
		}
		if (code === 1e3) return say("ended", why);
		return say("dropped", why);
	};
	const leave = () => {
		if (h$1.current) h$1.current.blur();
		if (panel.current) panel.current.focus({ preventScroll: true });
	};
	const enter = () => {
		if (h$1.current) h$1.current.focus();
	};
	h(() => {
		const L = live.current;
		L.alive = true;
		(async () => {
			let T;
			try {
				T = await __vitePreload(() => import("./term.js"), []);
			} catch (e) {
				say("failed", e && e.message);
				return;
			}
			if (!L.alive || !host.current) return;
			L.touch = T.isTouch();
			setTouch(L.touch);
			h$1.current = T.mount(host.current, {
				socket: fleet.termSocket,
				onState,
				onMessage: (o) => {
					if (o.t === "hello") {
						L.hello = true;
						if (o.idle > 0) L.idle = o.idle;
						if (o.session) setTab(o.session);
					}
				},
				onLeave: leave,
				onFocus: (up) => {
					if (L.alive) setFocused(up);
				},
				onCopy: () => toast(t("term.copied"), "good"),
				fontSize: startFont(T),
				onFont: (px) => {
					if (L.touch) try {
						localStorage.setItem(FONT_KEY, String(px));
					} catch {}
				}
			});
			if (L.touch && row.current && !row.current.firstChild) T.keyRow(row.current, () => h$1.current);
			if (!L.touch) h$1.current.focus();
			open();
		})();
		return () => {
			L.alive = false;
			const x = h$1.current;
			h$1.current = null;
			if (x) try {
				x.dispose();
			} catch {}
		};
	}, []);
	const onKeyDown = (e) => {
		if (e.target !== panel.current) return;
		if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
			e.preventDefault();
			e.stopPropagation();
			enter();
		}
	};
	const tool = (label, aria, act, cls = "") => /* @__PURE__ */ u("button", {
		type: "button",
		class: `btn ghost tt${cls}`,
		"aria-label": aria,
		title: aria,
		onPointerDown: keepFocus,
		onMouseDown: keepFocus,
		onClick: () => h$1.current && act(h$1.current),
		children: label
	});
	const ready = phase === "open";
	return /* @__PURE__ */ u("section", {
		class: `tool k-${kind}${touch ? " touch" : ""}`,
		ref: panel,
		tabIndex: -1,
		onKeyDown,
		"aria-label": t(`term.tab.${kind}`),
		children: [
			/* @__PURE__ */ u("div", {
				class: "tool-bar",
				children: [/* @__PURE__ */ u("p", {
					class: "tool-cap",
					children: [
						t(`term.cap.${kind}`, { project }),
						" ",
						/* @__PURE__ */ u("code", { children: tab }),
						phase === "opening" || phase === "loading" ? /* @__PURE__ */ u("span", {
							class: "tool-st",
							children: [" · ", t("term.opening")]
						}) : null
					]
				}), /* @__PURE__ */ u("div", {
					class: "tool-acts",
					children: [touch ? /* @__PURE__ */ u("span", {
						class: "tool-tools",
						children: [
							tool("A−", t("term.smaller"), (x) => x.zoom(-1)),
							tool("A+", t("term.larger"), (x) => x.zoom(1)),
							tool(/* @__PURE__ */ u(Icon, {
								name: "keyboard",
								size: 24
							}), t("term.keyboard"), (x) => x.keyboard(), ` kbd${focused ? " on" : ""}`)
						]
					}) : null, /* @__PURE__ */ u(Btn, {
						kind: "ghost sm tool-leave",
						disabled: !ready,
						onPointerDown: keepFocus,
						onMouseDown: keepFocus,
						onClick: () => focused ? leave() : enter(),
						children: [t(`term.${focused ? "leave" : "enter"}.${kind}`), touch ? null : /* @__PURE__ */ u("kbd", { children: focused ? "⇧Esc" : "⏎" })]
					})]
				})]
			}),
			notice ? /* @__PURE__ */ u(Notice, {
				n: notice,
				kind,
				fleet,
				onAgain: () => {
					open();
					if (!live.current.touch) enter();
				}
			}) : null,
			/* @__PURE__ */ u("div", {
				class: `tool-host${ready ? "" : " off"}`,
				ref: host
			}),
			/* @__PURE__ */ u("div", {
				class: "tool-keys",
				ref: row,
				hidden: !touch
			})
		]
	});
}
//#endregion
//#region web/ui/transcript.js
var LIVE_MS = 2e3;
var IDLE_MS = 5e3;
var FIRST_GIVEUP_MS = 8e3;
var GIVEUP_MS = 3e4;
var RETRY_MAX_MS = 15e3;
var pageKey = (m) => `${m && m.role}|${m && m.ts}|${String(m && m.text || "").slice(0, 200)}`;
function mergeNewest(cur, fresh) {
	const ms = fresh && fresh.messages || [];
	if (!cur || !ms.length) return {
		...fresh,
		pages: 1
	};
	const old = cur.messages || [], k = pageKey(ms[0]);
	let at = -1;
	for (let i = old.length - 1; i >= 0; i--) if (pageKey(old[i]) === k) {
		at = i;
		break;
	}
	if (at < 0) return {
		...fresh,
		pages: 1
	};
	return {
		...fresh,
		messages: [...old.slice(0, at), ...ms],
		next_before: cur.next_before,
		pages: cur.pages || 1
	};
}
var why = (e) => e && e.status === 429 ? t("chat.slowDown") : e && e.name === "OfflineError" ? t("chat.offline") : String(e && e.message || e);
var quiet = (e) => e && (e.status === 429 || e.name === "OfflineError" || e.name === "AuthError");
function useTranscript(fleet, project, name, live) {
	const [page, setPage] = d(null);
	const [load, setLoad] = d({
		tries: 0,
		why: ""
	});
	const [older, setOlder] = d({
		busy: false,
		err: ""
	});
	const r = A(null);
	const liveRef = A(live);
	liveRef.current = live;
	h(() => {
		const st = {
			seq: 0,
			drawn: 0,
			read: null,
			timer: null,
			cur: null,
			tries: 0,
			hiddenAt: 0,
			gone: false,
			err: "",
			olderBusy: false
		};
		r.current = st;
		setPage(null);
		setLoad({
			tries: 0,
			why: ""
		});
		setOlder({
			busy: false,
			err: ""
		});
		const held = () => typeof fleet.heldFor === "function" ? fleet.heldFor() : 0;
		const period = () => !st.cur ? Math.min(1e3 * 2 ** Math.max(0, st.tries - 1), RETRY_MAX_MS) : liveRef.current && liveRef.current() ? LIVE_MS : IDLE_MS;
		const failed = (w) => {
			if (st.cur) return false;
			st.tries++;
			setLoad({
				tries: st.tries,
				why: w
			});
			return true;
		};
		const read = ({ fresh = false } = {}) => {
			if (st.read) {
				const age = Date.now() - st.read.at;
				const stale = st.read.at < st.hiddenAt || age > 3e3;
				const dead = age > (st.cur ? GIVEUP_MS : FIRST_GIVEUP_MS);
				if (!dead && (!fresh || !stale)) return st.read.p;
				if (dead) failed(t("chat.noAnswer"));
				try {
					st.read.ctl && st.read.ctl.abort();
				} catch {}
			}
			const ctl = typeof AbortController === "function" ? new AbortController() : null;
			const me = {
				seq: ++st.seq,
				ctl,
				at: Date.now(),
				p: null
			};
			st.read = me;
			me.p = (async () => {
				try {
					const got = await fleet.session(project, name, null, {
						etag: st.cur && st.cur.etag || "",
						signal: ctl ? ctl.signal : void 0
					});
					if (st.gone || ctl && ctl.signal.aborted) return;
					if (st.cur && st.drawn > me.seq) return;
					if (st.tries) {
						st.tries = 0;
						setLoad({
							tries: 0,
							why: ""
						});
					}
					st.err = "";
					if (got && got.notModified) {
						if (st.cur) st.drawn = me.seq;
						return;
					}
					st.cur = mergeNewest(st.cur, got);
					st.drawn = me.seq;
					setPage(st.cur);
				} catch (e) {
					if (st.gone || ctl && ctl.signal.aborted) return;
					const w = why(e);
					if (failed(w) || quiet(e)) return;
					if (w !== st.err) {
						st.err = w;
						toast(w, "bad");
					}
				} finally {
					if (st.read === me) st.read = null;
				}
			})();
			return me.p;
		};
		const arm = (ms = period()) => {
			clearTimeout(st.timer);
			st.timer = null;
			if (st.gone || document.hidden) return;
			st.timer = setTimeout(() => {
				st.timer = null;
				if (st.gone || document.hidden) return;
				read();
				arm();
			}, Math.max(ms, held()));
		};
		const resume = () => {
			if (st.gone || document.hidden) return;
			read({ fresh: true }).finally(() => arm());
		};
		const vis = () => {
			if (document.hidden) {
				st.hiddenAt = Date.now();
				clearTimeout(st.timer);
				st.timer = null;
			} else resume();
		};
		const shown = (e) => {
			if (e && e.persisted) resume();
		};
		st.read$ = read;
		st.arm = arm;
		read();
		arm();
		document.addEventListener("visibilitychange", vis);
		addEventListener("pageshow", shown);
		addEventListener("focus", resume);
		return () => {
			st.gone = true;
			clearTimeout(st.timer);
			try {
				st.read && st.read.ctl && st.read.ctl.abort();
			} catch {}
			document.removeEventListener("visibilitychange", vis);
			removeEventListener("pageshow", shown);
			removeEventListener("focus", resume);
		};
	}, [
		fleet,
		project,
		name
	]);
	const reload = () => {
		const st = r.current;
		if (st && st.read$) st.read$({ fresh: true }).finally(() => st.arm());
	};
	const loadOlder = async (before) => {
		const st = r.current, s = st && st.cur;
		if (!s || !s.next_before || st.olderBusy) return;
		st.olderBusy = true;
		setOlder({
			busy: true,
			err: ""
		});
		try {
			const got = await fleet.session(project, name, s.next_before);
			if (st.gone) return;
			const cur = st.cur || s;
			st.cur = mergeNewest({
				...cur,
				messages: [...got.messages || [], ...s.messages || []],
				next_before: got.next_before ?? null,
				pages: (s.pages || 1) + 1
			}, cur);
			if (before) before();
			setPage(st.cur);
			setOlder({
				busy: false,
				err: ""
			});
		} catch (e) {
			if (!st.gone) setOlder({
				busy: false,
				err: why(e)
			});
		} finally {
			st.olderBusy = false;
		}
	};
	const retryOlder = (before) => {
		setOlder({
			busy: false,
			err: ""
		});
		if (r.current) r.current.olderBusy = false;
		return loadOlder(before);
	};
	return {
		page,
		load,
		older,
		loadOlder,
		retryOlder,
		reload
	};
}
//#endregion
//#region web/ui/drafts.js
var LS = "gfw.drafts";
var DAYS = 30;
var drafts = null;
var lost = /* @__PURE__ */ new Map();
var kept$1 = /* @__PURE__ */ new Map();
var draftKey = (project, session) => `${project || ""}\x1f${session || ""}`;
function load$1() {
	if (drafts) return drafts;
	drafts = /* @__PURE__ */ new Map();
	try {
		const o = JSON.parse(localStorage.getItem(LS) || "{}") || {};
		const old = Date.now() / 1e3 - DAYS * 86400;
		for (const [k, v] of Object.entries(o)) {
			if (!v || typeof v.text !== "string" || (v.at || 0) < old) continue;
			drafts.set(k, v);
			if (v.files > 0) lost.set(k, v.files);
		}
	} catch {}
	return drafts;
}
function persist() {
	try {
		localStorage.setItem(LS, JSON.stringify(Object.fromEntries(drafts)));
	} catch {}
}
function draftText(key) {
	const d = load$1().get(key);
	return d ? d.text : "";
}
function draftFiles(key) {
	return kept$1.get(key) || [];
}
function lostFiles(key) {
	load$1();
	return lost.get(key) || 0;
}
function keepDraft(key, text, files = draftFiles(key)) {
	const m = load$1();
	if (files.length) kept$1.set(key, files);
	else kept$1.delete(key);
	const n = files.filter((f) => f.state !== "err").length;
	if (!text && !n) m.delete(key);
	else m.set(key, {
		text: String(text || ""),
		files: n,
		at: Math.floor(Date.now() / 1e3)
	});
	persist();
}
function seenLost(key) {
	lost.delete(key);
}
function sentDraft(key) {
	seenLost(key);
	keepDraft(key, "", []);
}
//#endregion
//#region web/ui/session.jsx
function optionText(label) {
	const l = String(label || "");
	if (/^yes,? and don.?t ask again/i.test(l)) return {
		text: t("sess.opt.yesAlways"),
		sub: l,
		kind: "yes"
	};
	if (/^yes,? allow all edits/i.test(l)) return {
		text: t("sess.opt.yesEdits"),
		sub: l,
		kind: "yes"
	};
	if (/^yes/i.test(l)) return {
		text: t("sess.opt.yes"),
		sub: l,
		kind: "yes"
	};
	if (/^no/i.test(l)) return {
		text: t("sess.opt.no"),
		sub: l,
		kind: "no"
	};
	return {
		text: l,
		sub: "",
		kind: ""
	};
}
function PromptCard({ prompt, onAnswer, busy }) {
	const [typed, setTyped] = d("");
	if (prompt.kind === "permission") return /* @__PURE__ */ u("div", {
		class: "ask permission",
		children: [
			/* @__PURE__ */ u("div", {
				class: "ask-head",
				children: [/* @__PURE__ */ u("b", { children: ["● ", t("sess.asksPermission")] }), /* @__PURE__ */ u("span", { children: prompt.tool || t("sess.aTool") })]
			}),
			prompt.command ? /* @__PURE__ */ u("pre", {
				class: "ask-cmd",
				children: prompt.command.replace(/╌+/g, "").trim()
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "ask-opts",
				children: (prompt.options || []).map((o) => {
					const op = optionText(o.label);
					return /* @__PURE__ */ u("button", {
						disabled: busy,
						class: `opt ${op.kind}`,
						onClick: () => onAnswer(String(o.n), false),
						children: [/* @__PURE__ */ u("span", {
							class: "n",
							children: o.n
						}), /* @__PURE__ */ u("span", { children: [/* @__PURE__ */ u("b", { children: op.text }), op.sub ? /* @__PURE__ */ u("small", { children: op.sub }) : null] })]
					}, o.n);
				})
			}),
			/* @__PURE__ */ u("p", {
				class: "muted small",
				children: t("sess.checkCmd")
			})
		]
	});
	const tabs = (prompt.tabs || []).filter((x) => !x.submit);
	return /* @__PURE__ */ u("div", {
		class: "ask question",
		children: [
			/* @__PURE__ */ u("div", {
				class: "ask-head",
				children: [
					/* @__PURE__ */ u("b", { children: ["● ", t("sess.asks")] }),
					tabs.length > 1 ? /* @__PURE__ */ u("span", { children: t("sess.qOf", {
						i: prompt.tab != null ? prompt.tab + 1 : "?",
						n: tabs.length
					}) }) : null,
					prompt.submit ? /* @__PURE__ */ u("span", { children: t("sess.review") }) : null
				]
			}),
			/* @__PURE__ */ u("p", {
				class: "ask-q",
				children: prompt.question
			}),
			prompt.typing ? /* @__PURE__ */ u("form", {
				class: "row",
				onSubmit: (e) => {
					e.preventDefault();
					if (typed.trim()) onAnswer(typed.trim(), false);
				},
				children: [/* @__PURE__ */ u("input", {
					class: "grow",
					value: typed,
					onInput: (e) => setTyped(e.currentTarget.value),
					placeholder: t("sess.yourAnswer"),
					autoFocus: true
				}), /* @__PURE__ */ u(Btn, {
					kind: "primary",
					type: "submit",
					disabled: busy || !typed.trim(),
					children: t("common.send")
				})]
			}) : /* @__PURE__ */ u("div", {
				class: "ask-opts",
				children: (prompt.options || []).map((o) => /* @__PURE__ */ u("button", {
					disabled: busy,
					class: `opt${o.chosen ? " chosen" : ""}`,
					onClick: () => onAnswer(String(o.n), true),
					children: [/* @__PURE__ */ u("span", {
						class: "n",
						children: o.n
					}), /* @__PURE__ */ u("span", { children: [/* @__PURE__ */ u("b", { children: o.label }), o.description ? /* @__PURE__ */ u("small", { children: o.description }) : null] })]
				}, o.n))
			})
		]
	});
}
function Terminal({ pane }) {
	const ref = A(null);
	const stick = A(true);
	const html = pane ? render$1(pane).html : "";
	h(() => {
		const n = ref.current;
		if (n && stick.current) n.scrollTop = n.scrollHeight;
	}, [html]);
	return /* @__PURE__ */ u("div", {
		class: "term",
		ref,
		onScroll: (e) => {
			const n = e.currentTarget;
			stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 40;
		},
		children: pane == null ? /* @__PURE__ */ u("p", {
			class: "muted",
			children: t("sess.readingTerm")
		}) : /* @__PURE__ */ u("pre", {
			class: "pane",
			dangerouslySetInnerHTML: { __html: html }
		})
	});
}
function keyed(msgs) {
	const seen = /* @__PURE__ */ new Map();
	return msgs.map((m) => {
		const k = `${m.ts}:${m.role}`;
		const n = seen.get(k) || 0;
		seen.set(k, n + 1);
		return [`${k}:${n}`, m];
	});
}
function ChatLoading({ load }) {
	return /* @__PURE__ */ u("div", {
		class: "chat",
		"aria-busy": "true",
		children: [load.tries ? /* @__PURE__ */ u("p", {
			class: "loading err center",
			role: "status",
			children: t("chat.loadFailed", { why: load.why })
		}) : null, [
			0,
			1,
			2
		].map((i) => /* @__PURE__ */ u("div", {
			class: `msg ${i === 1 ? "me" : "ai"} skel`,
			"aria-hidden": "true",
			children: /* @__PURE__ */ u("div", { class: "bubble skel" })
		}, i))]
	});
}
var OLDER_NEAR_PX = 240;
var SWIPE_NEXT = 60;
var EDGE = 24;
function Chat({ page, queued, older, onOlder, onRetryOlder, onStep }) {
	const author = useSlot("author");
	const ref = A(null);
	const stick = A(true);
	const anchor = A(null);
	const swipe = A(null);
	const msgs = page.messages || [];
	const rows = keyed(msgs);
	const last = rows.length ? rows[rows.length - 1][0] : "";
	h(() => {
		const n = ref.current;
		if (n && stick.current) n.scrollTop = n.scrollHeight;
	}, [last, queued.length]);
	const measure = () => {
		const box = ref.current;
		if (!box) return;
		const top = box.getBoundingClientRect().top;
		const n = [...box.children].find((c) => c.dataset.k && c.getBoundingClientRect().bottom > top);
		anchor.current = n ? {
			k: n.dataset.k,
			top: n.getBoundingClientRect().top
		} : null;
	};
	const held = () => {
		const box = ref.current, a = anchor.current;
		return a && box ? [...box.children].find((c) => c.dataset.k === a.k) : null;
	};
	_(() => {
		const box = ref.current, a = anchor.current;
		if (a && box) {
			const n = held();
			const d = n ? n.getBoundingClientRect().top - a.top : 0;
			if (d) box.scrollTop += d;
			if (!older.busy) anchor.current = null;
		}
		if (box && page.next_before && !older.busy && !older.err && box.scrollHeight <= box.clientHeight + 1) onOlder();
	});
	const nearTop = (box) => {
		const n = held();
		if (n) anchor.current.top = n.getBoundingClientRect().top;
		if (!page.next_before || older.busy || older.err) return;
		if (box.scrollHeight <= box.clientHeight || box.scrollTop > OLDER_NEAR_PX) return;
		measure();
		onOlder();
	};
	const down = (e) => {
		swipe.current = e.pointerType !== "mouse" && e.clientX > EDGE ? {
			x: e.clientX,
			y: e.clientY
		} : null;
	};
	const up = (e) => {
		const s0 = swipe.current;
		swipe.current = null;
		if (!s0 || !onStep) return;
		const dx = e.clientX - s0.x, dy = e.clientY - s0.y;
		if (Math.abs(dx) < SWIPE_NEXT || Math.abs(dx) <= Math.abs(dy) * 2) return;
		onStep(dx < 0 ? 1 : -1);
	};
	return /* @__PURE__ */ u("div", {
		class: "chat",
		ref,
		"data-keep-scroll": "chat",
		onPointerDown: down,
		onPointerUp: up,
		onPointerCancel: () => {
			swipe.current = null;
		},
		onScroll: (e) => {
			const n = e.currentTarget;
			stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60;
			nearTop(n);
		},
		children: [
			page.next_before ? older.busy ? /* @__PURE__ */ u("p", {
				class: "older muted center",
				role: "status",
				children: t("chat.olderLoading")
			}) : older.err ? /* @__PURE__ */ u("div", {
				class: "older center",
				children: [/* @__PURE__ */ u("span", {
					class: "muted",
					children: t("chat.olderFailed", { why: older.err })
				}), /* @__PURE__ */ u("button", {
					class: "link",
					onClick: () => {
						measure();
						onRetryOlder();
					},
					children: t("sess.older")
				})]
			}) : null : msgs.length ? /* @__PURE__ */ u("p", {
				class: "start muted center",
				children: t("chat.start")
			}) : null,
			!msgs.length ? /* @__PURE__ */ u("p", {
				class: "muted center",
				children: t("sess.noMsgs")
			}) : null,
			rows.map(([k, m]) => {
				if (m.role === "tools") {
					const tools = m.tools || [];
					const names = [...new Set(tools.map((x) => x.name))];
					return /* @__PURE__ */ u("details", {
						"data-k": k,
						class: "tools",
						children: [/* @__PURE__ */ u("summary", { children: [
							/* @__PURE__ */ u(Icon, { name: "gear" }),
							" ",
							t("sess.actions", { n: tools.length }),
							" · ",
							names.slice(0, 4).join(", "),
							names.length > 4 ? "…" : "",
							/* @__PURE__ */ u("span", {
								class: "when",
								children: sinceTs(m.ts)
							})
						] }), /* @__PURE__ */ u("ul", { children: tools.map((x, j) => /* @__PURE__ */ u("li", { children: [
							/* @__PURE__ */ u("b", { children: x.name }),
							" ",
							/* @__PURE__ */ u("span", { children: x.detail })
						] }, j)) })]
					}, k);
				}
				return /* @__PURE__ */ u("div", {
					"data-k": k,
					class: `msg ${m.role === "user" ? "me" : "ai"}`,
					children: [/* @__PURE__ */ u("div", {
						class: "who",
						children: [m.role === "user" ? /* @__PURE__ */ u(S$1, { children: author(m) || t("sess.instruction") }) : "Claude", /* @__PURE__ */ u("span", {
							class: "when",
							children: sinceTs(m.ts)
						})]
					}), /* @__PURE__ */ u("div", {
						class: "bubble",
						children: m.role === "user" ? /* @__PURE__ */ u("p", {
							class: "plain",
							children: m.text
						}) : /* @__PURE__ */ u(Markdown, { text: m.text })
					})]
				}, k);
			}),
			queued.map((q, i) => /* @__PURE__ */ u("div", {
				class: "msg me pending",
				children: [/* @__PURE__ */ u("div", {
					class: "who",
					children: t("sess.queuedMsg")
				}), /* @__PURE__ */ u("div", {
					class: "bubble",
					children: /* @__PURE__ */ u("p", {
						class: "plain",
						children: q.text
					})
				})]
			}, `q${i}`))
		]
	});
}
var hhmm$1 = (at) => (/* @__PURE__ */ new Date(at * 1e3)).toLocaleString(locale(), {
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit"
});
var localInput = (d) => (/* @__PURE__ */ new Date(d.getTime() - d.getTimezoneOffset() * 6e4)).toISOString().slice(0, 16);
function ScheduleModal({ name, onClose, onSave }) {
	const [msg, setMsg] = d(() => t("sched.default"));
	const [when, setWhen] = d(() => localInput(new Date(Date.now() + 36e5)));
	const [busy, setBusy] = d(false);
	const quick = [
		[t("sched.in30"), () => Date.now() + 18e5],
		[t("sched.in1h"), () => Date.now() + 36e5],
		[t("sched.in3h"), () => Date.now() + 108e5],
		[t("sched.tomorrow"), () => {
			const d = /* @__PURE__ */ new Date();
			d.setDate(d.getDate() + 1);
			d.setHours(9, 0, 0, 0);
			return d.getTime();
		}]
	];
	const save = async (ms) => {
		setBusy(true);
		try {
			await onSave(Math.floor(ms / 1e3), msg.trim() || t("sched.default"));
			onClose();
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u(Modal, {
		title: t("sched.title", { name }),
		onClose,
		children: /* @__PURE__ */ u("div", {
			class: "stack modal-body",
			children: [
				/* @__PURE__ */ u("p", {
					class: "muted",
					children: t("sched.why")
				}),
				/* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t("sched.message") }), /* @__PURE__ */ u("textarea", {
						rows: 3,
						value: msg,
						onInput: (e) => setMsg(e.currentTarget.value)
					})]
				}),
				/* @__PURE__ */ u("div", {
					class: "quick",
					children: quick.map(([l, f]) => /* @__PURE__ */ u(Btn, {
						kind: "ghost",
						disabled: busy,
						onClick: () => save(f()),
						children: l
					}, l))
				}),
				/* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t("sched.exact") }), /* @__PURE__ */ u("input", {
						type: "datetime-local",
						value: when,
						onInput: (e) => setWhen(e.currentTarget.value)
					})]
				}),
				/* @__PURE__ */ u("footer", { children: [/* @__PURE__ */ u(Btn, {
					onClick: onClose,
					children: t("common.cancel")
				}), /* @__PURE__ */ u(Btn, {
					kind: "primary",
					disabled: busy || !when,
					onClick: () => save(new Date(when).getTime()),
					children: t("sched.go")
				})] })
			]
		})
	});
}
function SessionView({ project, name, card, onChanged, onGone, onStep = null, tool = null, embedded = false, quiet = false }) {
	const fleet = useFleet();
	const ownerPicker = useSlot("ownerPicker"), presence = useSlot("presence");
	const [tab, setTab] = d("chat");
	const pick = (x) => {
		setTab(x);
		if (tool) fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`);
	};
	const dkey = draftKey(project, name);
	const [draft, setDraftState] = d(() => draftText(dkey));
	const setDraft = (v) => {
		setDraftState(v);
		keepDraft(dkey, v);
	};
	const [lost, setLost] = d(() => lostFiles(dkey));
	const [busy, setBusy] = d(false);
	const [confirm, setConfirm] = d(null);
	const [rename, setRename] = d(null);
	const [menu, setMenu] = d(false);
	const can = (verb) => typeof fleet.can === "function" ? fleet.can(verb) : true;
	const menuWrap = A(null);
	useLayer(menu, (n) => menuWrap.current?.contains(n), (focus) => {
		setMenu(false);
		if (focus) menuWrap.current?.querySelector(".btn")?.focus({ preventScroll: true });
	});
	const [labelEdit, setLabelEdit] = d(null);
	const [schedOpen, setSchedOpen] = d(false);
	const [files, setFilesState] = d(() => draftFiles(dkey));
	const mounted = A(true);
	h(() => () => {
		mounted.current = false;
	}, []);
	const setFiles = (fn) => {
		const next = fn(draftFiles(dkey));
		keepDraft(dkey, draftText(dkey), next);
		if (mounted.current) setFilesState(next);
	};
	const [drag, setDrag] = d(false);
	const picker = A(null);
	const typing = A(!!draft);
	const sentAt = A(0);
	const statusNow = A("unknown");
	const quietRef = A(quiet);
	quietRef.current = quiet;
	const tr = useTranscript(fleet, project, name, () => !quietRef.current && (statusNow.current === "working" || statusNow.current === "starting" || Date.now() - sentAt.current < 12e4));
	const lastPane = A({
		at: 0,
		data: null
	});
	const pane = usePoll(async () => {
		const was = lastPane.current;
		if (quietRef.current && was.data && Date.now() - was.at < 15e3) return was.data;
		const data = await fleet.pane(project, name);
		lastPane.current = {
			at: Date.now(),
			data
		};
		return data;
	}, 2500, [project, name]);
	h(() => {
		if (!fleet.presence) return void 0;
		const iv = setInterval(() => {
			if (!document.hidden) fleet.presence(project, name, typing.current).catch(() => {});
		}, 5e3);
		return () => clearInterval(iv);
	}, [project, name]);
	const st = card ? statusOf(card) : tr.page?.status || "unknown";
	statusNow.current = st;
	const owner = card?.owner || tr.page?.owner || null;
	const prompt = pane.data?.prompt || null;
	const act = async (tool, args = {}, opts = {}) => {
		setBusy(true);
		try {
			const r = await fleet.act(tool, {
				project,
				session: name,
				...args
			}, opts);
			if (r.queued === "question") toast(t("sess.queuedQ"), "");
			else if (r.queued) toast(t("sess.queuedTurn"), "");
			onChanged();
			tr.reload();
			pane.reload();
			return r;
		} catch (e) {
			if (e.body?.changed) {
				toast(t("sess.changed"), "bad");
				pane.reload();
			} else toast(e.message, "bad");
			return null;
		} finally {
			setBusy(false);
		}
	};
	const answer = (text, noEnter) => act("fleet_answer", {
		text,
		no_enter: noEnter,
		expect: prompt?.fingerprint
	});
	const addFiles = (list) => {
		const picked = [...list || []].slice(0, Math.max(0, fleet.attachPerMessage - files.length));
		if (list?.length > picked.length) toast(t("sess.maxFiles", { n: fleet.attachPerMessage }), "");
		for (const f of picked) {
			const id = Math.random().toString(36).slice(2);
			const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : null;
			setFiles((x) => [...x, {
				id,
				name: f.name || t("sess.pasted"),
				size: f.size,
				state: "up",
				preview
			}]);
			fleet.attach(project, name, f).then((r) => setFiles((x) => x.map((y) => y.id === id ? {
				...y,
				state: "ok",
				path: r.path
			} : y))).catch((e) => setFiles((x) => x.map((y) => y.id === id ? {
				...y,
				state: "err",
				why: e.message
			} : y)));
		}
	};
	const dropFile = (id) => setFiles((x) => {
		const f = x.find((y) => y.id === id);
		if (f?.preview) URL.revokeObjectURL(f.preview);
		return x.filter((y) => y.id !== id);
	});
	const uploading = files.some((f) => f.state === "up");
	const ready = files.filter((f) => f.state === "ok");
	const sendDraft = async () => {
		const text = draft.trim();
		if (!text && !ready.length || uploading) return;
		const list = ready.map((f) => `- ${f.path}`).join("\n");
		const prompt = !ready.length ? text : `${text || t("sess.attaching", { n: ready.length })}\n\n${t("sess.attached", { n: ready.length })}:\n${list}`;
		if (await act("fleet_send", { prompt })) {
			sentAt.current = Date.now();
			typing.current = false;
			for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
			sentDraft(dkey);
			setDraftState("");
			setLost(0);
			if (mounted.current) setFilesState([]);
		}
	};
	const stop = (reclaim) => setConfirm({
		title: reclaim ? t("sess.stopRmTitle") : t("sess.stopTitle"),
		action: reclaim ? t("sess.stopRm") : t("sess.stop"),
		danger: true,
		typed: reclaim ? name : null,
		body: reclaim ? /* @__PURE__ */ u("p", { children: [
			t("sess.stopRmBody.a"),
			/* @__PURE__ */ u("b", { children: name }),
			t("sess.stopRmBody.b")
		] }) : /* @__PURE__ */ u("p", { children: [
			t("sess.stopRmBody.a"),
			/* @__PURE__ */ u("b", { children: name }),
			t("sess.stopBody.b")
		] }),
		onYes: async () => {
			const r = await act("fleet_stop", reclaim ? { reclaim: true } : {}, { confirm: true });
			if (r) {
				toast(r.text?.split("\n")[0] || t("sess.stopped"), "good");
				onGone();
			}
		}
	});
	const parked = st === "parked";
	return /* @__PURE__ */ u("section", {
		class: "session",
		children: [
			/* @__PURE__ */ u("header", {
				class: `sess-head${embedded ? " embedded" : ""}`,
				children: [
					embedded ? null : /* @__PURE__ */ u(BackLink, { parent: `/p/${encodeURIComponent(project)}` }),
					/* @__PURE__ */ u("div", {
						class: "sess-title",
						children: [
							embedded ? null : /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Ship, {
								state: st,
								size: 32
							}), /* @__PURE__ */ u("h1", { children: name })] }),
							/* @__PURE__ */ u(StatusPill, { status: st }),
							card?.branch ? /* @__PURE__ */ u("span", {
								class: "branch",
								children: [
									/* @__PURE__ */ u(Icon, { name: "branch" }),
									" ",
									card.branch
								]
							}) : null,
							card?.pr ? /* @__PURE__ */ u("span", {
								class: "tag pr",
								children: ["PR ", card.pr]
							}) : null,
							card?.label ? can("gfw_label") ? /* @__PURE__ */ u("button", {
								class: "chip-label",
								title: t("sess.changeLabel"),
								onClick: () => setLabelEdit(card.label),
								children: [
									/* @__PURE__ */ u(Icon, { name: "tag" }),
									" ",
									card.label
								]
							}) : /* @__PURE__ */ u("span", {
								class: "chip-label",
								children: [
									/* @__PURE__ */ u(Icon, { name: "tag" }),
									" ",
									card.label
								]
							}) : null,
							card?.sched ? /* @__PURE__ */ u("span", {
								class: "chip-sched",
								title: t("sess.schedMsg", { msg: card.sched.msg || "" }),
								children: [
									/* @__PURE__ */ u(Icon, { name: "clock" }),
									" ",
									hhmm$1(card.sched.at),
									" · “",
									String(card.sched.msg || "").slice(0, 30),
									"”",
									can("gfw_unschedule") ? /* @__PURE__ */ u("button", {
										"aria-label": t("sess.unsched"),
										onClick: () => act("gfw_unschedule"),
										children: /* @__PURE__ */ u(Icon, { name: "close" })
									}) : null
								]
							}) : null
						]
					}),
					/* @__PURE__ */ u("div", {
						class: "sess-tools",
						children: [
							ownerPicker({
								project,
								name,
								owner,
								onChanged: () => {
									onChanged();
									tr.reload();
								}
							}),
							st === "working" ? /* @__PURE__ */ u(Btn, {
								kind: "ghost sm",
								disabled: busy,
								onClick: () => act("fleet_interrupt"),
								title: t("sess.interruptHint"),
								icon: "hand",
								children: t("sess.interrupt")
							}) : null,
							st === "asleep" ? /* @__PURE__ */ u(Btn, {
								kind: "ghost sm",
								disabled: busy,
								onClick: () => act("fleet_wake"),
								icon: "sun",
								children: t("sess.wake")
							}) : null,
							st === "lost" ? /* @__PURE__ */ u(Btn, {
								kind: "ghost sm",
								disabled: busy,
								onClick: () => act("fleet_reopen"),
								icon: "refresh",
								children: t("sess.reopen")
							}) : null,
							card && !card.lead && !["asleep", "lost"].includes(st) ? /* @__PURE__ */ u(Btn, {
								kind: "ghost sm",
								disabled: busy,
								onClick: () => act(parked ? "fleet_resume" : "fleet_pause"),
								icon: parked ? "play" : "pause",
								children: parked ? t("sess.resume") : t("sess.pause")
							}) : null,
							/* @__PURE__ */ u("div", {
								class: "menu-wrap",
								ref: menuWrap,
								children: [/* @__PURE__ */ u(Btn, {
									kind: "ghost sm",
									onClick: () => setMenu((m) => !m),
									"aria-haspopup": "true",
									"aria-expanded": menu,
									children: [t("sess.more"), " ▾"]
								}), menu ? /* @__PURE__ */ u("div", {
									class: "menu",
									children: [
										can("gfw_label") ? /* @__PURE__ */ u("button", {
											onClick: () => {
												setMenu(false);
												setLabelEdit(card?.label || "");
											},
											children: [
												/* @__PURE__ */ u(Icon, { name: "tag" }),
												" ",
												t("sess.setLabel")
											]
										}) : null,
										can("gfw_schedule") ? /* @__PURE__ */ u("button", {
											onClick: () => {
												setMenu(false);
												setSchedOpen(true);
											},
											children: [
												/* @__PURE__ */ u(Icon, { name: "clock" }),
												" ",
												t("sess.schedule")
											]
										}) : null,
										card && !card.lead ? /* @__PURE__ */ u("button", {
											onClick: () => {
												setMenu(false);
												setRename(name);
											},
											children: t("sess.renameMenu")
										}) : null,
										card && !card.lead ? /* @__PURE__ */ u("button", {
											onClick: () => {
												setMenu(false);
												stop(false);
											},
											children: t("sess.stopMenu")
										}) : null,
										card && !card.lead ? /* @__PURE__ */ u("button", {
											class: "danger",
											onClick: () => {
												setMenu(false);
												stop(true);
											},
											children: t("sess.stopRmMenu")
										}) : null
									]
								}) : null]
							})
						]
					}),
					presence(pane.data?.here || [])
				]
			}),
			st === "limit" ? /* @__PURE__ */ u("div", {
				class: "ask limit",
				children: [
					/* @__PURE__ */ u("div", {
						class: "ask-head",
						children: [/* @__PURE__ */ u("b", { children: [
							/* @__PURE__ */ u(Icon, { name: "hourglass" }),
							" ",
							t("status.limit.hint")
						] }), card?.limit_at ? /* @__PURE__ */ u("span", { children: t("sess.quotaBack", { when: hhmm$1(card.limit_at) }) }) : null]
					}),
					/* @__PURE__ */ u("p", {
						class: "muted small",
						children: t("sess.limitWhy")
					}),
					card?.sched ? /* @__PURE__ */ u("p", { children: t("sess.alreadySched", { when: hhmm$1(card.sched.at) }) }) : !can("gfw_schedule") ? null : /* @__PURE__ */ u("div", {
						class: "row wrap",
						children: [/* @__PURE__ */ u(Btn, {
							kind: "primary",
							disabled: busy,
							onClick: () => act("gfw_schedule", {
								at: (card?.limit_at || Math.floor(Date.now() / 1e3) + 18e3) + 90,
								msg: t("sess.continueMsg")
							}),
							children: [
								/* @__PURE__ */ u(Icon, { name: "clock" }),
								" ",
								t("sess.resumeOnQuota")
							]
						}), /* @__PURE__ */ u(Btn, {
							kind: "ghost",
							onClick: () => setSchedOpen(true),
							children: t("sess.otherTime")
						})]
					})
				]
			}) : null,
			prompt ? /* @__PURE__ */ u(PromptCard, {
				prompt,
				onAnswer: answer,
				busy
			}, prompt.fingerprint) : null,
			/* @__PURE__ */ u("div", {
				class: "tabs",
				role: "tablist",
				children: [
					/* @__PURE__ */ u("button", {
						role: "tab",
						class: !tool && tab === "chat" ? "on" : "",
						onClick: () => pick("chat"),
						children: t("sess.chat")
					}),
					/* @__PURE__ */ u("button", {
						role: "tab",
						class: !tool && tab === "term" ? "on" : "",
						title: t("sess.screenHint"),
						onClick: () => pick("term"),
						children: t("sess.screen")
					}),
					/* @__PURE__ */ u(ToolTabs, {
						project,
						session: name,
						tool
					})
				]
			}),
			tool ? /* @__PURE__ */ u(ToolPanel, {
				project,
				session: name,
				kind: tool
			}, tool) : tab === "chat" ? !tr.page ? /* @__PURE__ */ u(ChatLoading, { load: tr.load }) : /* @__PURE__ */ u(Chat, {
				page: tr.page,
				queued: tr.page.queued || [],
				older: tr.older,
				onOlder: tr.loadOlder,
				onRetryOlder: tr.retryOlder,
				onStep
			}) : /* @__PURE__ */ u(Terminal, { pane: pane.data?.pane ?? null }),
			!tool && /* @__PURE__ */ u("form", {
				class: `composer${drag ? " drag" : ""}`,
				onSubmit: (e) => {
					e.preventDefault();
					sendDraft();
				},
				onDragOver: (e) => {
					if (e.dataTransfer?.types?.includes("Files")) {
						e.preventDefault();
						setDrag(true);
					}
				},
				onDragLeave: () => setDrag(false),
				onDrop: (e) => {
					if (e.dataTransfer?.files?.length) {
						e.preventDefault();
						setDrag(false);
						addFiles(e.dataTransfer.files);
					}
				},
				children: [
					lost ? /* @__PURE__ */ u("p", {
						class: "att-lost",
						role: "status",
						children: [
							t("sess.filesLost", { n: lost }),
							" ",
							/* @__PURE__ */ u("button", {
								type: "button",
								class: "link-btn",
								onClick: () => {
									seenLost(dkey);
									setLost(0);
								},
								children: t("common.ok")
							})
						]
					}) : null,
					files.length ? /* @__PURE__ */ u("div", {
						class: "att-list",
						children: files.map((f) => /* @__PURE__ */ u("span", {
							class: `att att-${f.state}`,
							title: f.why || f.path || f.name,
							children: [
								f.preview ? /* @__PURE__ */ u("img", {
									src: f.preview,
									alt: ""
								}) : /* @__PURE__ */ u("i", {
									class: "att-ico",
									children: /* @__PURE__ */ u(Icon, {
										name: "file",
										size: 24
									})
								}),
								/* @__PURE__ */ u("span", {
									class: "att-name",
									children: f.name
								}),
								/* @__PURE__ */ u("small", { children: f.state === "up" ? t("sess.uploading") : f.state === "err" ? t("sess.notUploaded") : `${Math.max(1, Math.round(f.size / 1024))} KB` }),
								/* @__PURE__ */ u("button", {
									type: "button",
									class: "att-x",
									"aria-label": t("sess.remove", { name: f.name }),
									onClick: () => dropFile(f.id),
									children: /* @__PURE__ */ u(Icon, { name: "close" })
								})
							]
						}, f.id))
					}) : null,
					/* @__PURE__ */ u("div", {
						class: "composer-row",
						children: [
							/* @__PURE__ */ u("button", {
								type: "button",
								class: "attach-btn",
								onClick: () => picker.current?.click(),
								title: t("sess.attach"),
								"aria-label": t("sess.attach"),
								children: /* @__PURE__ */ u(Icon, {
									name: "clip",
									size: 24
								})
							}),
							/* @__PURE__ */ u("input", {
								ref: picker,
								type: "file",
								multiple: true,
								hidden: true,
								onChange: (e) => {
									addFiles(e.currentTarget.files);
									e.currentTarget.value = "";
								}
							}),
							/* @__PURE__ */ u("textarea", {
								rows: 2,
								value: draft,
								placeholder: drag ? t("sess.drop") : prompt ? t("sess.pendingAbove") : t("sess.writeTo", { name }),
								onInput: (e) => {
									setDraft(e.currentTarget.value);
									typing.current = !!e.currentTarget.value;
								},
								onPaste: (e) => {
									const fs = [...e.clipboardData?.files || []];
									if (fs.length) {
										e.preventDefault();
										addFiles(fs);
									}
								},
								onKeyDown: (e) => {
									if (e.key === "Escape" && !e.isComposing) {
										e.preventDefault();
										e.currentTarget.blur();
									} else if (sendsOnEnter(e)) {
										e.preventDefault();
										sendDraft();
									}
								}
							}),
							/* @__PURE__ */ u(Btn, {
								kind: "primary",
								type: "submit",
								disabled: busy || uploading || !draft.trim() && !ready.length,
								children: uploading ? t("sess.uploadingBtn") : t("common.send")
							})
						]
					})
				]
			}),
			confirm ? /* @__PURE__ */ u(Confirm, {
				...confirm,
				onClose: () => setConfirm(null)
			}) : null,
			schedOpen ? /* @__PURE__ */ u(ScheduleModal, {
				name,
				onClose: () => setSchedOpen(false),
				onSave: async (at, msg) => {
					const r = await act("gfw_schedule", {
						at,
						msg
					});
					if (r) toast(r.text, "good");
				}
			}) : null,
			labelEdit != null ? /* @__PURE__ */ u(Modal, {
				title: t("sess.labelTitle"),
				onClose: () => setLabelEdit(null),
				children: /* @__PURE__ */ u("form", {
					class: "stack modal-body",
					onSubmit: async (e) => {
						e.preventDefault();
						if (await act("gfw_label", { text: labelEdit })) setLabelEdit(null);
					},
					children: [
						/* @__PURE__ */ u("p", {
							class: "muted",
							children: t("sess.labelWhy")
						}),
						/* @__PURE__ */ u("label", {
							class: "field",
							children: [/* @__PURE__ */ u("span", { children: t("sess.labelField") }), /* @__PURE__ */ u("input", {
								maxLength: 40,
								value: labelEdit,
								onInput: (e) => setLabelEdit(e.currentTarget.value),
								autoFocus: true
							})]
						}),
						/* @__PURE__ */ u("footer", { children: [/* @__PURE__ */ u(Btn, {
							onClick: () => setLabelEdit(null),
							children: t("common.cancel")
						}), /* @__PURE__ */ u(Btn, {
							kind: "primary",
							type: "submit",
							children: t("common.save")
						})] })
					]
				})
			}) : null,
			rename != null ? /* @__PURE__ */ u(Modal, {
				title: t("sess.renameTitle"),
				onClose: () => setRename(null),
				children: /* @__PURE__ */ u("form", {
					class: "stack modal-body",
					onSubmit: async (e) => {
						e.preventDefault();
						if (await act("fleet_rename", { new_name: rename.trim() }, { confirm: true })) {
							setRename(null);
							fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(rename.trim())}`, { replace: true });
						}
					},
					children: [/* @__PURE__ */ u("label", {
						class: "field",
						children: [/* @__PURE__ */ u("span", { children: t("sess.newName") }), /* @__PURE__ */ u("input", {
							value: rename,
							onInput: (e) => setRename(e.currentTarget.value),
							autoFocus: true
						})]
					}), /* @__PURE__ */ u("footer", { children: [/* @__PURE__ */ u(Btn, {
						onClick: () => setRename(null),
						children: t("common.cancel")
					}), /* @__PURE__ */ u(Btn, {
						kind: "primary",
						type: "submit",
						disabled: !rename.trim() || rename.trim() === name,
						children: t("sess.rename")
					})] })]
				})
			}) : null
		]
	});
}
//#endregion
//#region web/ui/project.jsx
var GROUPS = Object.values(worded({
	need: {
		id: "need",
		has: (s) => s === "need-you"
	},
	work: {
		id: "work",
		has: (s) => s === "working" || s === "starting"
	},
	ready: {
		id: "ready",
		has: (s) => s === "ready" || s === "interrupted" || s === "limit"
	},
	rest: {
		id: "rest",
		has: () => true
	}
}, "group", ["title", "hint"]));
function Card({ c, active, compact, onOpen }) {
	const st = statusOf(c);
	const foot = useSlot("cardFoot")(c);
	return /* @__PURE__ */ u("article", {
		class: `card s-${(STATUS[st] || STATUS.unknown).color}${active ? " active" : ""}${compact ? " compact" : ""}`,
		tabIndex: 0,
		onClick: onOpen,
		onKeyDown: (e) => {
			if (e.key === "Enter") onOpen();
		},
		children: [
			/* @__PURE__ */ u("div", {
				class: "card-top",
				children: [/* @__PURE__ */ u(StatusPill, {
					status: st,
					small: true
				}), /* @__PURE__ */ u("span", {
					class: "age",
					children: c.age != null ? ago(c.age) : ""
				})]
			}),
			/* @__PURE__ */ u("h3", { children: [c.name, c.lead ? /* @__PURE__ */ u("span", {
				class: "tag",
				children: t("common.lead")
			}) : null] }),
			c.label ? /* @__PURE__ */ u("span", {
				class: "card-label",
				children: [
					/* @__PURE__ */ u(Icon, { name: "tag" }),
					" ",
					c.label
				]
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "card-meta",
				children: [
					/* @__PURE__ */ u("span", {
						class: "branch",
						title: t("project.branch"),
						children: [
							/* @__PURE__ */ u(Icon, { name: "branch" }),
							" ",
							c.branch || "—"
						]
					}),
					c.pr ? /* @__PURE__ */ u("span", {
						class: "tag pr",
						children: ["PR ", c.pr]
					}) : null,
					c.queued ? /* @__PURE__ */ u("span", {
						class: "tag",
						children: t("project.queued", { n: c.queued })
					}) : null,
					c.sched ? /* @__PURE__ */ u("span", {
						class: "tag sched",
						title: c.sched.msg || "",
						children: [
							/* @__PURE__ */ u(Icon, { name: "clock" }),
							" ",
							(/* @__PURE__ */ new Date(c.sched.at * 1e3)).toLocaleTimeString(locale(), {
								hour: "2-digit",
								minute: "2-digit"
							})
						]
					}) : null
				]
			}),
			!compact && c.msg ? /* @__PURE__ */ u("p", {
				class: "card-msg",
				children: c.msg
			}) : null,
			foot ? /* @__PURE__ */ u("div", {
				class: "card-foot",
				children: foot
			}) : null
		]
	});
}
var allCards = (cards) => cards;
function ProjectView({ project, session, tool = null }) {
	const fleet = useFleet();
	const filterCards = useSlot("filterCards", allCards), filterChips = useSlot("filterChips");
	const { data: g, error, reload } = usePoll(() => fleet.grid(project), 3e3, [project]);
	const [filter, setFilter] = useKept("project.filter", "all");
	const [spawn, setSpawn] = d(null);
	const [confirm, setConfirm] = d(null);
	const cards = T(() => filterCards(g?.cards || [], filter), [g, filter]);
	const open = (name) => fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(name)}`);
	const step = (d) => {
		const names = (g?.cards || []).map((c) => c.name), at = names.indexOf(session), to = at + d;
		if (at < 0 || to < 0 || to >= names.length) return;
		fleet.go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(names[to])}`, { replace: true });
	};
	const current = session && g ? g.cards.find((c) => c.name === session) : null;
	const removeWorktree = (w) => setConfirm({
		title: t("project.rmTitle"),
		action: t("project.rmAction"),
		danger: true,
		body: /* @__PURE__ */ u("p", { children: [
			t("project.rmBody.a"),
			/* @__PURE__ */ u("code", { children: w.path }),
			t("project.rmBody.b"),
			/* @__PURE__ */ u("code", { children: w.branch }),
			t("project.rmBody.c")
		] }),
		onYes: async () => {
			try {
				toast((await fleet.act("fleet_worktree_remove", {
					project,
					path: w.path
				}, { confirm: true })).text || t("project.rmDone"), "good");
			} catch (e) {
				toast(e.message, "bad");
			}
			reload();
		}
	});
	const lead = (g?.cards || []).find((c) => c.lead);
	const leadUp = lead && !lead.lost && !lead.asleep && statusOf(lead) !== "parked";
	const hasSelection = () => {
		try {
			return String(getSelection() || "") !== "";
		} catch {
			return false;
		}
	};
	const sessionBack = () => back(projectTo(project));
	const cycle = (d) => {
		const cs = g?.cards || [];
		const next = cycleName([...cs.filter((c) => c.lead), ...cs.filter((c) => !c.lead)].map((c) => c.name), session, d);
		if (next && next !== session) open(next);
	};
	useKeys((key, e, layer) => {
		const { k, lk, ctrl } = key;
		const cs = g?.cards || [];
		if (session) {
			if (layer.prefix) {
				layer.prefix = false;
				if (ctrl) return lk === "a";
				if (lk === "g" || lk === "d") sessionBack();
				else if (lk === "s") fleet.go(projectTo(project));
				else if (lk === "p") fleet.go("/");
				else if (lk === "f") layer.startJump();
				else if (k === "ArrowRight") cycle(1);
				else if (k === "ArrowLeft") cycle(-1);
				else if ((lk === "t" || lk === "n") && offers(fleet, project)) fleet.go(toolTo(project, session, lk === "t" ? "term" : "edit"));
				return true;
			}
			if (ctrl) {
				if (lk === "a") {
					layer.prefix = true;
					return true;
				}
				if (lk === "s") {
					fleet.go(projectTo(project));
					return true;
				}
				return false;
			}
			if (k === "`") {
				sessionBack();
				return true;
			}
			if (key.shift && (k === "ArrowRight" || k === "ArrowLeft")) {
				cycle(k === "ArrowRight" ? 1 : -1);
				return true;
			}
			if (k.length === 1 && !key.alt) return typeIntoComposer(k);
			if (k === "Enter") return focusComposer();
			return false;
		}
		if (ctrl) return lk === "c" && !hasSelection() ? layer.toLead(project, cs) : false;
		const d = dirOf(key);
		if (d) {
			moveFocus(".main .cards .card", d);
			return true;
		}
		if (key.alt) return false;
		if (k === "n" || k === "N") {
			setSpawn({});
			return true;
		}
		if (k === "q" || k === "`") return layer.toLead(project, cs);
		if (/^[1-9]$/.test(k)) {
			const c = cs[Number(k) - 1];
			if (c) open(c.name);
			return true;
		}
		return false;
	});
	const [waking, setWaking] = d(false);
	const wake = async () => {
		setWaking(true);
		try {
			toast((await fleet.lead(project)).started ? t("project.leadReady") : t("project.leadWasOpen"), "good");
			reload();
		} catch (e) {
			toast(t("project.leadFailed", { why: e.message }), "bad");
		} finally {
			setWaking(false);
		}
	};
	const termWhy = typeof fleet.termWhy === "function" ? fleet.termWhy(project) : "";
	const header = /* @__PURE__ */ u("header", {
		class: "page-head",
		children: [/* @__PURE__ */ u("div", { children: [
			/* @__PURE__ */ u("h1", {
				class: "name",
				children: /* @__PURE__ */ u(ProjectName, { name: project })
			}),
			/* @__PURE__ */ u("p", {
				class: "muted",
				children: g ? `${t("project.sessions", { n: g.cards.length })} · ${t("project.freeWts", { n: g.free_worktrees?.length || 0 })}` : t("common.loading")
			}),
			termWhy ? /* @__PURE__ */ u("p", {
				class: "muted term-why",
				children: termWhy
			}) : null
		] }), /* @__PURE__ */ u("div", {
			class: "row wrap",
			children: [g && !leadUp ? /* @__PURE__ */ u(Btn, {
				kind: "ghost",
				disabled: waking,
				onClick: wake,
				title: t("project.leadIs"),
				children: waking ? t("status.starting") + "…" : !lead ? /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u(Icon, { name: "play" }),
					" ",
					t("project.leadStart")
				] }) : lead.lost ? /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u(Icon, { name: "refresh" }),
					" ",
					t("project.leadReopen")
				] }) : lead.asleep ? /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u(Icon, { name: "sun" }),
					" ",
					t("project.leadWake")
				] }) : /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u(Icon, { name: "play" }),
					" ",
					t("project.leadResume")
				] })
			}) : null, /* @__PURE__ */ u(Btn, {
				kind: "primary",
				icon: "plus",
				onClick: () => setSpawn({}),
				children: t("project.newSession")
			})]
		})]
	});
	const filters = filterChips({
		cards: g?.cards || [],
		filter,
		setFilter
	});
	const modals = /* @__PURE__ */ u(S$1, { children: [spawn ? /* @__PURE__ */ u(NewSession, {
		project,
		free: g?.free_worktrees || [],
		preset: spawn,
		onClose: () => setSpawn(null),
		onDone: (name) => {
			setSpawn(null);
			reload();
			open(name);
		}
	}) : null, confirm ? /* @__PURE__ */ u(Confirm, {
		...confirm,
		onClose: () => setConfirm(null)
	}) : null] });
	if (error && !g) return /* @__PURE__ */ u("div", {
		class: "page",
		children: [header, /* @__PURE__ */ u("p", {
			class: "err",
			children: t("project.readFailed", {
				project,
				why: error.message
			})
		})]
	});
	if (session) return /* @__PURE__ */ u("div", {
		class: "split",
		children: [
			/* @__PURE__ */ u("aside", {
				class: "split-list",
				children: [/* @__PURE__ */ u("div", {
					class: "split-head",
					children: [/* @__PURE__ */ u("a", {
						class: "link split-name",
						href: `#${projectTo(project)}`,
						children: /* @__PURE__ */ u(ProjectName, { name: project })
					}), /* @__PURE__ */ u(Btn, {
						kind: "ghost sm",
						icon: "plus",
						onClick: () => setSpawn({}),
						children: t("project.new")
					})]
				}), (g?.cards || []).map((c) => /* @__PURE__ */ u(Card, {
					c,
					compact: true,
					active: c.name === session,
					onOpen: () => open(c.name)
				}, c.name))]
			}),
			/* @__PURE__ */ u(SessionView, {
				project,
				name: session,
				card: current,
				tool,
				onChanged: reload,
				onGone: sessionBack,
				onStep: step
			}, `${project}/${session}`),
			modals
		]
	});
	if (tool) return /* @__PURE__ */ u("div", {
		class: "page page-tool",
		children: [
			header,
			/* @__PURE__ */ u(ProjectTabs, {
				project,
				tool
			}),
			/* @__PURE__ */ u(ToolPanel, {
				project,
				kind: tool
			}, tool),
			modals
		]
	});
	return /* @__PURE__ */ u("div", {
		class: "page",
		children: [
			header,
			/* @__PURE__ */ u(ProjectTabs, {
				project,
				tool: null
			}),
			filters,
			g && !g.cards.length ? /* @__PURE__ */ u("div", {
				class: "empty",
				children: [
					/* @__PURE__ */ u("p", { children: /* @__PURE__ */ u("b", { children: t("project.empty") }) }),
					/* @__PURE__ */ u("p", {
						class: "muted",
						children: t("project.emptyWhy")
					}),
					/* @__PURE__ */ u(Btn, {
						kind: "primary",
						icon: "plus",
						onClick: () => setSpawn({}),
						children: t("project.openFirst")
					})
				]
			}) : null,
			GROUPS.map((gr, i) => {
				const taken = new Set(GROUPS.slice(0, i).flatMap((x) => cards.filter((c) => x.has(statusOf(c))).map((c) => c.name)));
				const list = cards.filter((c) => !taken.has(c.name) && gr.has(statusOf(c)));
				if (!list.length) return null;
				return /* @__PURE__ */ u("section", {
					class: `group g-${gr.id}`,
					children: [/* @__PURE__ */ u("h2", { children: [
						gr.title,
						" ",
						/* @__PURE__ */ u("span", {
							class: "count",
							children: list.length
						}),
						/* @__PURE__ */ u("small", { children: gr.hint })
					] }), /* @__PURE__ */ u("div", {
						class: "cards",
						children: list.map((c) => /* @__PURE__ */ u(Card, {
							c,
							onOpen: () => open(c.name)
						}, c.name))
					})]
				}, gr.id);
			}),
			g && (g.cards.length || g.free_worktrees?.length) ? /* @__PURE__ */ u("section", {
				class: "group",
				children: [/* @__PURE__ */ u("h2", { children: [
					t("project.tree"),
					" ",
					/* @__PURE__ */ u("small", { children: t("project.treeHint") })
				] }), /* @__PURE__ */ u(Tree, {
					g,
					open,
					onReuse: (w) => setSpawn({ reuse: w.path }),
					onRemove: removeWorktree
				})]
			}) : null,
			modals
		]
	});
}
function Tree({ g, open, onReuse, onRemove }) {
	const treeOwner = useSlot("treeOwner");
	const cards = g.cards || [];
	const lead = cards.find((c) => c.lead);
	const kids = (name) => cards.filter((c) => !c.lead && (c.parent || null) === name);
	const top = cards.filter((c) => !c.lead && (!c.parent || !cards.some((x) => x.name === c.parent)));
	const Row = ({ c, depth }) => {
		const st = statusOf(c), meta = STATUS[st] || STATUS.unknown;
		return /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("button", {
			class: `tree-row c-${meta.color}`,
			style: { "--d": depth },
			onClick: () => open(c.name),
			children: [
				/* @__PURE__ */ u("span", {
					class: "tree-branch",
					"aria-hidden": "true",
					children: depth ? "└─" : ""
				}),
				/* @__PURE__ */ u("b", {
					class: "tree-glyph",
					children: /* @__PURE__ */ u(StatusMark, { status: st })
				}),
				/* @__PURE__ */ u("span", {
					class: "tree-name",
					children: [c.lead ? t("common.lead") : c.name, c.label ? /* @__PURE__ */ u("em", { children: [" · ", c.label] }) : null]
				}),
				/* @__PURE__ */ u("span", {
					class: "tree-meta",
					children: [
						/* @__PURE__ */ u(Icon, { name: "folder" }),
						" ",
						c.folder || "—",
						" · ",
						/* @__PURE__ */ u(Icon, { name: "branch" }),
						" ",
						c.branch || "—"
					]
				}),
				/* @__PURE__ */ u("span", {
					class: "tree-st",
					children: meta.label
				}),
				treeOwner(c)
			]
		}), kids(c.name).map((k) => /* @__PURE__ */ u(Row, {
			c: k,
			depth: depth + 1
		}, k.name))] });
	};
	return /* @__PURE__ */ u("div", {
		class: "tree",
		children: [
			lead ? /* @__PURE__ */ u(Row, {
				c: lead,
				depth: 0
			}) : /* @__PURE__ */ u("div", {
				class: "tree-row static",
				children: /* @__PURE__ */ u("span", {
					class: "muted",
					children: t("project.noLead")
				})
			}),
			top.map((c) => /* @__PURE__ */ u(Row, {
				c,
				depth: 1
			}, c.name)),
			(g.free_worktrees || []).map((w) => /* @__PURE__ */ u("div", {
				class: "tree-row free-row",
				style: { "--d": 1 },
				children: [
					/* @__PURE__ */ u("span", {
						class: "tree-branch",
						"aria-hidden": "true",
						children: "└─"
					}),
					/* @__PURE__ */ u("b", {
						class: "tree-glyph",
						children: "○"
					}),
					/* @__PURE__ */ u("span", {
						class: "tree-name",
						children: [
							w.path.split("/").pop(),
							" ",
							/* @__PURE__ */ u("em", {
								class: "muted",
								children: t("project.free")
							})
						]
					}),
					/* @__PURE__ */ u("span", {
						class: "tree-meta",
						children: [
							/* @__PURE__ */ u(Icon, { name: "branch" }),
							" ",
							w.branch,
							" · ",
							w.path
						]
					}),
					/* @__PURE__ */ u("span", {
						class: "row",
						children: [/* @__PURE__ */ u(Btn, {
							kind: "ghost sm",
							onClick: () => onReuse(w),
							children: t("project.openHere")
						}), /* @__PURE__ */ u(Btn, {
							kind: "ghost sm danger",
							onClick: () => onRemove(w),
							children: t("common.delete")
						})]
					})
				]
			}, w.path))
		]
	});
}
var slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
function NewSession({ project, free, preset, onClose, onDone }) {
	const fleet = useFleet();
	const spawnOwner = useSlot("spawnOwner");
	const [name, setName] = d("");
	const [prompt, setPrompt] = d("");
	const [owner, setOwner] = d(void 0);
	const [where, setWhere] = d(preset.reuse || "new");
	const [branch, setBranch] = d("");
	const [from, setFrom] = d("");
	const [model, setModel] = d("");
	const [busy, setBusy] = d(false);
	const [err, setErr] = d("");
	const n = slugify(name);
	const submit = async (e) => {
		e.preventDefault();
		setErr("");
		setBusy(true);
		const args = {
			project,
			name: n,
			prompt: prompt.trim() || void 0,
			model: model || void 0,
			branch: branch.trim() || void 0,
			from: from.trim() || void 0
		};
		if (where === "new") {
			if (free.length) args.force_new = true;
		} else args.reuse = where;
		try {
			toast((await fleet.act("fleet_spawn", args, { owner })).text?.split("\n")[0] || t("project.created"), "good");
			onDone(n);
		} catch (x) {
			setErr(x.message);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u(Modal, {
		title: t("project.newSession"),
		onClose,
		wide: true,
		children: /* @__PURE__ */ u("form", {
			onSubmit: submit,
			class: "stack modal-body",
			children: [
				/* @__PURE__ */ u("p", {
					class: "muted",
					children: t("project.newWhy")
				}),
				/* @__PURE__ */ u("label", {
					class: "field",
					children: [
						/* @__PURE__ */ u("span", { children: t("auth.name") }),
						/* @__PURE__ */ u("input", {
							value: name,
							onInput: (e) => setName(e.currentTarget.value),
							placeholder: t("project.namePh"),
							autoFocus: true
						}),
						name && n !== name ? /* @__PURE__ */ u("small", {
							class: "muted",
							children: [
								t("project.willBe"),
								" ",
								/* @__PURE__ */ u("code", { children: n })
							]
						}) : null
					]
				}),
				/* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t("project.what") }), /* @__PURE__ */ u("textarea", {
						rows: 5,
						value: prompt,
						onInput: (e) => setPrompt(e.currentTarget.value),
						placeholder: t("project.whatPh")
					})]
				}),
				/* @__PURE__ */ u("div", {
					class: "grid2",
					children: [spawnOwner({
						value: owner,
						onChange: setOwner
					}), /* @__PURE__ */ u(Select, {
						label: t("project.where"),
						value: where,
						onChange: setWhere,
						options: [{
							value: "new",
							label: t("project.newWt")
						}, ...free.map((w) => ({
							value: w.path,
							label: t("project.reuse", {
								name: w.path.split("/").pop(),
								branch: w.branch
							})
						}))]
					})]
				}),
				/* @__PURE__ */ u("details", {
					class: "advanced",
					children: [/* @__PURE__ */ u("summary", { children: t("project.advanced") }), /* @__PURE__ */ u("div", {
						class: "grid3",
						children: [
							/* @__PURE__ */ u("label", {
								class: "field",
								children: [/* @__PURE__ */ u("span", { children: t("project.branch") }), /* @__PURE__ */ u("input", {
									value: branch,
									onInput: (e) => setBranch(e.currentTarget.value),
									placeholder: n || t("project.sameAsName")
								})]
							}),
							/* @__PURE__ */ u("label", {
								class: "field",
								children: [/* @__PURE__ */ u("span", { children: t("project.from") }), /* @__PURE__ */ u("input", {
									value: from,
									onInput: (e) => setFrom(e.currentTarget.value),
									placeholder: t("project.fromPh")
								})]
							}),
							/* @__PURE__ */ u(Select, {
								label: t("project.model"),
								value: model,
								onChange: setModel,
								options: [
									{
										value: "",
										label: t("project.accountModel")
									},
									{
										value: "opus",
										label: "Opus"
									},
									{
										value: "sonnet",
										label: "Sonnet"
									},
									{
										value: "haiku",
										label: "Haiku"
									}
								]
							})
						]
					})]
				}),
				err ? /* @__PURE__ */ u("p", {
					class: "err",
					children: err
				}) : null,
				/* @__PURE__ */ u("footer", { children: [/* @__PURE__ */ u(Btn, {
					onClick: onClose,
					children: t("common.cancel")
				}), /* @__PURE__ */ u(Btn, {
					kind: "primary",
					type: "submit",
					disabled: !n || busy,
					children: busy ? t("common.creating") : t("project.create")
				})] })
			]
		})
	});
}
//#endregion
//#region web/ui/map.jsx
var shipState = (s) => s === "working" ? "acting" : s === "need-you" ? "thinking" : s === "starting" ? "sending" : "idle";
var WORD = (s) => (STATUS[s] || STATUS.unknown).label.toLowerCase();
function FleetMap({ projects }) {
	const { go } = useFleet();
	const ownerBadge = useSlot("ownerBadge");
	const tips = useShipTips();
	const [events, setEvents] = useKept("map.events", []);
	const [focus, setFocus] = useKept("map.focus", null);
	const [pos, setPos] = d(null);
	const [showIdle, setShowIdle] = useKept("map.idle", false);
	const prev = A(null);
	const sea = A(null);
	h(() => {
		if (!projects) return;
		const now = {};
		for (const p of projects) for (const s of p.sessions) now[`${p.name}/${s.name}`] = {
			p: p.name,
			s: s.name,
			st: s.status,
			lead: s.lead
		};
		const before = prev.current;
		prev.current = now;
		if (!before) {
			if (focus) return;
			const latest = projects.flatMap((p) => p.sessions.map((s) => ({
				p: p.name,
				s
			}))).sort((a, b) => (b.s.ts || 0) - (a.s.ts || 0))[0];
			if (latest) setFocus({
				project: latest.p,
				session: latest.s.name
			});
			return;
		}
		const fresh = [];
		for (const [k, v] of Object.entries(now)) {
			const was = before[k];
			if (was && was.st === v.st) continue;
			fresh.push({
				id: Math.random(),
				at: Date.now(),
				project: v.p,
				session: v.s,
				status: v.st,
				text: !was ? t("map.opened", {
					project: v.p,
					session: v.s
				}) : `${v.p} · ${v.lead ? t("common.lead") : v.s}: ${WORD(v.st)}`
			});
		}
		for (const k of Object.keys(before)) if (!now[k]) fresh.push({
			id: Math.random(),
			at: Date.now(),
			project: before[k].p,
			session: null,
			text: t("map.closed", {
				project: before[k].p,
				session: before[k].s
			})
		});
		if (fresh.length) {
			setEvents((e) => [...fresh, ...e].slice(0, 40));
			const f = fresh.find((x) => x.session) || fresh[0];
			setFocus({
				project: f.project,
				session: f.session
			});
		}
	}, [projects]);
	_(() => {
		const root = sea.current;
		if (!root || !focus) return;
		const sel = focus.session ? `[data-boat="${CSS.escape(`${focus.project}/${focus.session}`)}"]` : `[data-island="${CSS.escape(focus.project)}"]`;
		const el = root.querySelector(sel) || root.querySelector(`[data-island="${CSS.escape(focus.project)}"]`);
		if (!el) return;
		const isl = root.querySelector(`[data-island="${CSS.escape(focus.project)}"]`) || el;
		const a = root.getBoundingClientRect(), b = el.getBoundingClientRect(), i = isl.getBoundingClientRect();
		setPos({
			x: b.left - a.left + b.width / 2 + root.scrollLeft,
			y: i.top - a.top + root.scrollTop
		});
	}, [
		focus,
		projects,
		showIdle
	]);
	const active = (projects || []).filter((p) => p.sessions.length);
	const idle = (projects || []).filter((p) => !p.sessions.length);
	const shown = showIdle ? [...active, ...idle] : active;
	const fs = focus && (projects || []).find((p) => p.name === focus.project)?.sessions.find((s) => s.name === focus.session);
	return /* @__PURE__ */ u("div", {
		class: "page map-page",
		children: [/* @__PURE__ */ u("header", {
			class: "page-head",
			children: [/* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("h1", { children: t("nav.map") }), /* @__PURE__ */ u("p", {
				class: "muted",
				children: t("map.sub")
			})] }), /* @__PURE__ */ u("label", {
				class: "toggle-inline",
				children: [
					/* @__PURE__ */ u("input", {
						type: "checkbox",
						checked: showIdle,
						onChange: (e) => setShowIdle(e.currentTarget.checked)
					}),
					" ",
					t("map.showIdle", { n: idle.length })
				]
			})]
		}), /* @__PURE__ */ u("div", {
			class: "map-wrap",
			children: [
				/* @__PURE__ */ u("div", {
					class: "ocean",
					ref: sea,
					children: [
						projects == null ? /* @__PURE__ */ u("p", {
							class: "muted pad",
							children: t("map.reading")
						}) : null,
						projects && !shown.length ? /* @__PURE__ */ u("p", {
							class: "muted pad",
							children: t("map.none")
						}) : null,
						shown.map((p) => /* @__PURE__ */ u("section", {
							class: `island${p.counts.need_you ? " hot" : ""}${focus?.project === p.name ? " focus" : ""}`,
							"data-island": p.name,
							onPointerEnter: () => tips.warm(p.name),
							children: [/* @__PURE__ */ u("button", {
								class: "island-name",
								onClick: () => go(`/p/${encodeURIComponent(p.name)}`),
								children: [p.name, p.counts.need_you ? /* @__PURE__ */ u("span", {
									class: "badge need",
									children: p.counts.need_you
								}) : null]
							}), /* @__PURE__ */ u("div", {
								class: "boats",
								children: [p.sessions.map((s) => {
									const st = STATUS[s.status] || STATUS.unknown;
									const badge = ownerBadge(s, 15);
									return /* @__PURE__ */ u("button", {
										class: `boat c-${st.color} st-${s.status}`,
										"data-boat": `${p.name}/${s.name}`,
										...tips.bind({
											project: p.name,
											name: s.name,
											lead: s.lead,
											ts: s.ts,
											session: s,
											word: st.label,
											light: s.status
										}, () => go(`/p/${encodeURIComponent(p.name)}/s/${encodeURIComponent(s.name)}`)),
										children: [
											/* @__PURE__ */ u(Ship, {
												size: 34,
												state: s.status
											}),
											/* @__PURE__ */ u("span", {
												class: "boat-name",
												children: s.lead ? t("common.lead") : s.name
											}),
											badge ? /* @__PURE__ */ u("span", {
												class: "boat-owner",
												children: badge
											}) : null
										]
									}, s.name);
								}), !p.sessions.length ? /* @__PURE__ */ u("span", {
									class: "muted small",
									children: t("map.noSessions")
								}) : null]
							})]
						}, p.name)),
						pos ? /* @__PURE__ */ u("div", {
							class: "ghostship",
							style: { transform: `translate(calc(${pos.x}px - 50%), ${pos.y - 64}px)` },
							children: [
								focus ? /* @__PURE__ */ u("span", {
									class: "ghost-tag",
									children: focus.session ? `${focus.project} · ${focus.session}` : focus.project
								}) : null,
								/* @__PURE__ */ u(GhostShip, {
									size: 64,
									state: fs ? shipState(fs.status) : "idle"
								}),
								/* @__PURE__ */ u("span", { class: "ghost-beam" })
							]
						}) : null
					]
				}),
				tips.card,
				/* @__PURE__ */ u("aside", {
					class: "ticker",
					"data-keep-scroll": "ticker",
					children: [
						/* @__PURE__ */ u("h2", { children: t("map.live") }),
						!events.length ? /* @__PURE__ */ u("p", {
							class: "muted small",
							children: t("map.waiting")
						}) : null,
						events.map((e) => /* @__PURE__ */ u("button", {
							class: `tick c-${(STATUS[e.status] || STATUS.unknown).color}`,
							onClick: () => {
								setFocus({
									project: e.project,
									session: e.session
								});
								if (e.session) go(`/p/${encodeURIComponent(e.project)}/s/${encodeURIComponent(e.session)}`);
							},
							children: [
								/* @__PURE__ */ u("b", { children: /* @__PURE__ */ u(StatusMark, { status: e.status }) }),
								" ",
								/* @__PURE__ */ u("span", { children: e.text }),
								" ",
								/* @__PURE__ */ u("small", { children: sinceTs(Math.floor(e.at / 1e3)) })
							]
						}, e.id))
					]
				})
			]
		})]
	});
}
//#endregion
//#region web/ui/lang.js
var KEY$1 = "gfw.lang";
var saved = () => {
	try {
		return normLang(localStorage.getItem(KEY$1));
	} catch {
		return null;
	}
};
var cur = saved() || pickLang(typeof navigator !== "undefined" ? navigator.language : "");
setLangSource(() => cur);
if (typeof document !== "undefined") document.documentElement.lang = cur;
var subs$1 = /* @__PURE__ */ new Set();
function setLang(l) {
	const v = normLang(l);
	if (!v) return;
	try {
		localStorage.setItem(KEY$1, v);
	} catch {}
	if (v === cur) return;
	cur = v;
	if (typeof document !== "undefined") document.documentElement.lang = v;
	for (const f of subs$1) f(v);
}
function useLang() {
	const [l, setL] = d(cur);
	h(() => {
		subs$1.add(setL);
		return () => subs$1.delete(setL);
	}, []);
	return l;
}
//#endregion
//#region web/ui/views.jsx
var VERBS = words([
	"fleet_send",
	"attach",
	"fleet_answer",
	"fleet_interrupt",
	"fleet_pause",
	"fleet_resume",
	"fleet_wake",
	"fleet_reopen",
	"fleet_spawn",
	"fleet_stop",
	"fleet_rename",
	"fleet_worktree_remove",
	"fleet_unqueue",
	"assign",
	"login",
	"setup",
	"add_user",
	"password",
	"auto_save",
	"auto_delete",
	"route",
	"voice_install",
	"voice_delete"
], "verb");
var RESULT = {
	ran: "good",
	refused: "bad",
	changed: "warn"
};
function Activity() {
	const fleet = useFleet();
	const { data, error } = usePoll(() => fleet.activity(), 5e3, []);
	const [who, setWho] = useKept("activity.who", "all");
	const rows = (data?.rows || []).filter((r) => who === "all" || r.user === who);
	const people = useSlot("activityPeople");
	const face = useSlot("activityFace");
	const person = useSlot("activityWho", (r) => r.by ? /* @__PURE__ */ u("b", { children: r.by }) : null);
	return /* @__PURE__ */ u("div", {
		class: "page",
		children: [
			/* @__PURE__ */ u("header", {
				class: "page-head",
				children: /* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("h1", { children: t("activity.title") }), /* @__PURE__ */ u("p", {
					class: "muted",
					children: t("activity.sub")
				})] })
			}),
			people({
				who,
				setWho
			}),
			error ? /* @__PURE__ */ u("p", {
				class: "err",
				children: error.message
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "log",
				children: [rows.map((r, i) => {
					const [rl, rk] = RESULT[r.result] ? [t(`result.${r.result}`), RESULT[r.result]] : [r.result, ""];
					const target = r.subject && r.subject !== "-" ? r.subject : "";
					const detail = r.args?.prompt || r.args?.text || r.args?.new_name || r.detail || "";
					return /* @__PURE__ */ u("details", {
						class: "log-row",
						children: [
							/* @__PURE__ */ u("summary", { children: [
								/* @__PURE__ */ u("span", {
									class: "when",
									children: clock(r.ts)
								}),
								face(r),
								/* @__PURE__ */ u("span", {
									class: "grow",
									children: [
										person(r),
										" ",
										VERBS[r.verb] || r.verb,
										" ",
										target ? /* @__PURE__ */ u("b", { children: target }) : null,
										r.project ? /* @__PURE__ */ u("span", {
											class: "muted",
											children: [" · ", /* @__PURE__ */ u(ProjectName, { name: r.project })]
										}) : null,
										r.via ? /* @__PURE__ */ u("span", {
											class: "tag",
											children: [
												/* @__PURE__ */ u(Icon, { name: "bolt" }),
												" ",
												r.via
											]
										}) : null
									]
								}),
								/* @__PURE__ */ u("span", {
									class: `badge ${rk}`,
									children: rl
								})
							] }),
							detail ? /* @__PURE__ */ u("p", {
								class: "log-detail",
								children: [
									"“",
									String(detail),
									"”"
								]
							}) : null,
							r.output ? /* @__PURE__ */ u("pre", {
								class: "log-out",
								children: r.output
							}) : null
						]
					}, i);
				}), data && !rows.length ? /* @__PURE__ */ u("p", {
					class: "muted pad",
					children: t("activity.empty")
				}) : null]
			})
		]
	});
}
function Toggle({ label, hint, on, busy, onChange }) {
	return /* @__PURE__ */ u("label", {
		class: "set-row",
		children: [/* @__PURE__ */ u("span", {
			class: "grow",
			children: [/* @__PURE__ */ u("b", { children: label }), hint ? /* @__PURE__ */ u("small", {
				class: "muted",
				children: hint
			}) : null]
		}), /* @__PURE__ */ u("span", {
			class: "switch",
			children: [/* @__PURE__ */ u("input", {
				type: "checkbox",
				checked: !!on,
				disabled: busy,
				onChange: (e) => onChange(e.currentTarget.checked)
			}), /* @__PURE__ */ u("i", {})]
		})]
	});
}
function SwitchSection({ title, part, label, icon }) {
	const [st, setSt] = d(null);
	const [busy, setBusy] = d(false);
	const load = () => part.state().then(setSt, (e) => setSt({
		ready: false,
		why: e.message
	}));
	h(() => {
		load();
	}, []);
	const flip = async (on) => {
		setBusy(true);
		try {
			await part.set(on);
		} catch (e) {
			toast(e.message, "bad");
		}
		setBusy(false);
		load();
	};
	return /* @__PURE__ */ u("section", {
		class: "panel",
		children: [/* @__PURE__ */ u("h2", { children: [
			/* @__PURE__ */ u(Icon, { name: icon }),
			" ",
			title
		] }), st == null ? /* @__PURE__ */ u("p", {
			class: "muted",
			children: t("settings.reading")
		}) : st.ready === false ? /* @__PURE__ */ u("p", {
			class: "muted",
			children: st.why
		}) : /* @__PURE__ */ u(Toggle, {
			label,
			hint: st.why,
			on: st.on,
			busy,
			onChange: flip
		})]
	});
}
function Hosts({ part }) {
	const { data, error, reload } = usePoll(() => part.list(), 15e3, []);
	const [asking, setAsking] = d("");
	const hosts = data || [];
	return /* @__PURE__ */ u("section", {
		class: "panel",
		children: [
			/* @__PURE__ */ u("h2", { children: [
				/* @__PURE__ */ u(Icon, { name: "map" }),
				" ",
				t("settings.hosts")
			] }),
			error ? /* @__PURE__ */ u("p", {
				class: "err",
				children: error.message
			}) : null,
			data && !hosts.length ? /* @__PURE__ */ u("p", {
				class: "muted",
				children: t("settings.hostsNone")
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "rows",
				children: hosts.map((h) => /* @__PURE__ */ u("div", {
					class: "row-item static",
					children: [
						/* @__PURE__ */ u(Led, {
							state: h.self || h.online !== false ? "idle" : "off",
							size: 8
						}),
						/* @__PURE__ */ u("span", {
							class: "grow",
							children: [
								/* @__PURE__ */ u("b", { children: h.label || h.key }),
								" ",
								/* @__PURE__ */ u("small", {
									class: "muted",
									children: h.self ? t("settings.hostThis") : h.online === false ? t("settings.hostOffline") : t("settings.hostOnline")
								})
							]
						}),
						h.self ? null : asking === h.key ? /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Btn, {
							kind: "danger",
							onClick: async () => {
								try {
									await part.unpair(h.key);
									toast(t("settings.unpaired", { name: h.label || h.key }), "good");
								} catch (e) {
									toast(e.message, "bad");
								}
								setAsking("");
								reload();
							},
							children: t("settings.unpair")
						}), /* @__PURE__ */ u(Btn, {
							kind: "ghost",
							onClick: () => setAsking(""),
							children: t("common.cancel")
						})] }) : /* @__PURE__ */ u(Btn, {
							kind: "ghost",
							onClick: () => setAsking(h.key),
							children: t("settings.unpairQ")
						})
					]
				}, h.key))
			})
		]
	});
}
function Connection({ part, onChange }) {
	const [st, setSt] = d(() => part.state());
	const [url, setUrl] = d(() => st.detail || "");
	const [choice, setChoice] = d(st.choice);
	const apply = async (v, u = url) => {
		try {
			await part.choose(v, u);
			const n = part.state();
			setSt(n);
			setChoice(n.choice);
			onChange?.(n);
		} catch (e) {
			toast(e.message, "bad");
		}
	};
	const pick = (v) => {
		setChoice(v);
		if (v !== "server") apply(v);
	};
	return /* @__PURE__ */ u("section", {
		class: "panel",
		children: [
			/* @__PURE__ */ u("h2", { children: [
				/* @__PURE__ */ u(Icon, { name: "link" }),
				" ",
				t("settings.connection")
			] }),
			/* @__PURE__ */ u("p", { children: st.text }),
			st.detail ? /* @__PURE__ */ u("p", {
				class: "muted small",
				children: st.detail
			}) : null,
			part.choices ? /* @__PURE__ */ u("div", {
				class: "row wrap",
				children: [/* @__PURE__ */ u(Select, {
					label: t("settings.backend"),
					labelClass: "muted",
					value: choice,
					options: part.choices(),
					onChange: pick
				}), choice === "server" ? /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("input", {
					type: "url",
					inputMode: "url",
					placeholder: "https://",
					"aria-label": t("settings.serverUrl"),
					value: url,
					onInput: (e) => setUrl(e.currentTarget.value),
					onKeyDown: (e) => {
						if (e.key === "Enter") apply("server");
					}
				}), /* @__PURE__ */ u(Btn, {
					kind: "ghost",
					disabled: !/^https?:\/\/./.test(url),
					onClick: () => apply("server"),
					children: t("settings.useServer")
				})] }) : null]
			}) : null,
			part.reset ? /* @__PURE__ */ u(Btn, {
				kind: "ghost",
				onClick: async () => {
					try {
						await part.reset();
						toast(t("settings.demoReset"), "good");
					} catch (e) {
						toast(e.message, "bad");
					}
				},
				children: t("settings.resetDemo")
			}) : null
		]
	});
}
function Device({ part }) {
	const st = part.state();
	return /* @__PURE__ */ u("section", {
		class: "panel",
		children: [
			/* @__PURE__ */ u("h2", { children: [
				/* @__PURE__ */ u(Icon, { name: "key" }),
				" ",
				t("settings.device")
			] }),
			/* @__PURE__ */ u("p", { children: st.text }),
			st.detail ? /* @__PURE__ */ u("p", {
				class: "muted small",
				children: st.detail
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "row wrap",
				children: (part.actions?.() || []).map((a) => /* @__PURE__ */ u(Btn, {
					kind: a.kind || "ghost",
					onClick: async () => {
						try {
							await a.run();
						} catch (e) {
							toast(e.message, "bad");
						}
					},
					children: a.label
				}, a.id))
			})
		]
	});
}
function Settings() {
	const fleet = useFleet();
	const s = fleet.settings || {};
	const people = useSlot("settingsPeople");
	return /* @__PURE__ */ u("div", {
		class: "page narrow",
		children: [
			/* @__PURE__ */ u("header", {
				class: "page-head",
				children: /* @__PURE__ */ u("div", { children: /* @__PURE__ */ u("h1", { children: t("settings.title") }) })
			}),
			/* @__PURE__ */ u("section", {
				class: "panel",
				children: [/* @__PURE__ */ u("h2", { children: t("settings.language") }), /* @__PURE__ */ u(Select, {
					label: t("settings.languageHint"),
					labelClass: "muted",
					value: lang(),
					options: LANGS.map((l) => ({
						value: l,
						label: LANG_NAMES[l]
					})),
					onChange: (l) => {
						setLang(l);
						fleet.saveLang?.(l)?.catch?.((x) => toast(x.message, "bad"));
					}
				})]
			}),
			people(),
			s.push ? /* @__PURE__ */ u(SwitchSection, {
				title: t("settings.push"),
				label: t("settings.pushLabel"),
				icon: "bell",
				part: s.push
			}) : null,
			s.terminal ? /* @__PURE__ */ u(SwitchSection, {
				title: t("settings.terminal"),
				label: t("settings.terminalLabel"),
				icon: "term",
				part: s.terminal
			}) : null,
			s.hosts ? /* @__PURE__ */ u(Hosts, { part: s.hosts }) : null,
			s.device ? /* @__PURE__ */ u(Device, { part: s.device }) : null,
			s.connection ? /* @__PURE__ */ u(Connection, { part: s.connection }) : null,
			s.about ? /* @__PURE__ */ u("section", {
				class: "panel",
				children: [/* @__PURE__ */ u("h2", { children: t("settings.about") }), /* @__PURE__ */ u("p", {
					class: "muted small",
					children: s.about()
				})]
			}) : null
		]
	});
}
//#endregion
//#region web/ui/automations-model.js
var EVENTS$1 = worded({
	finished: {},
	"need-you": {},
	started: {},
	limit: {},
	lost: {},
	interrupted: {}
}, "phone.event", [
	"label",
	"hint",
	"verb"
]);
var ACTIONS$1 = worded({
	send: {
		icon: "mail",
		tool: "fleet_send",
		needs: [
			"project",
			"session",
			"prompt"
		]
	},
	spawn: {
		icon: "plus",
		tool: "fleet_spawn",
		needs: ["project", "name"],
		optional: ["prompt", "branch"]
	},
	pause: {
		icon: "pause",
		tool: "fleet_pause",
		needs: ["project", "session"]
	},
	resume: {
		icon: "play",
		tool: "fleet_resume",
		needs: ["project", "session"],
		optional: ["prompt"]
	},
	wake: {
		icon: "sun",
		tool: "fleet_wake",
		needs: ["project", "session"]
	},
	interrupt: {
		icon: "hand",
		tool: "fleet_interrupt",
		needs: ["project", "session"]
	},
	reopen: {
		icon: "refresh",
		tool: "fleet_reopen",
		needs: ["project", "session"]
	},
	stop: {
		icon: "stop",
		tool: "fleet_stop",
		needs: ["project", "session"],
		danger: true
	},
	check: {
		icon: "question",
		tool: null,
		needs: [
			"project",
			"session",
			"status"
		]
	},
	notify: {
		icon: "bell",
		tool: null,
		needs: ["text"]
	},
	wait: {
		icon: "hourglass",
		tool: null,
		needs: ["minutes"]
	},
	summary: {
		icon: "clipboard",
		tool: null,
		needs: []
	}
}, "phone.action");
var SCOPES = words(["personal", "company"], "phone.scope");
var STATES$2 = words([
	"need-you",
	"working",
	"ready",
	"idle",
	"parked",
	"limit",
	"interrupted",
	"asleep",
	"lost",
	"starting",
	"unknown"
], "phone.state");
var DAY_NAMES = words([
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6"
], "phone.day");
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
	status: action === "check" ? ["need-you"] : [],
	confirmed: false
});
var anyOr = (v, word) => !v || v === "*" ? word : v;
function daysWords(days) {
	const s = [...days].sort().join(",");
	if (s === "0,1,2,3,4,5,6") return t("phone.auto.days.all");
	if (s === "1,2,3,4,5") return t("phone.auto.days.weekdays");
	if (s === "0,6") return t("phone.auto.days.weekends");
	return t("phone.auto.days.list", { days: days.map((d) => DAY_NAMES[d]).join(", ") });
}
var cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function describeTrigger(tr) {
	if (!tr) return "";
	if (tr.type === "event") return t("phone.auto.trig.event", {
		who: tr.session && tr.session !== "*" ? t("phone.auto.trig.session", { session: tr.session }) : t("phone.auto.trig.anySession"),
		project: anyOr(tr.project, t("phone.auto.trig.anyProject")),
		what: EVENTS$1[tr.event]?.verb || tr.event
	});
	if (tr.mode === "once") return t("phone.auto.trig.once", {
		date: tr.date ? tr.date.split("-").reverse().join("/") : "?",
		at: tr.at
	});
	if (tr.mode === "every") return t("phone.auto.trig.every", { every: everyWords(tr.minutes) });
	return t("phone.auto.trig.days", {
		days: cap(daysWords(tr.days)),
		at: tr.at
	});
}
var everyWords = (m) => m % 1440 === 0 ? t("phone.auto.every.days", { n: m / 1440 }) : m % 60 === 0 ? `${m / 60} h` : `${m} min`;
var where = (s) => `${s.session === "{sesion}" ? t("phone.auto.step.eventSession") : s.session || "?"}${s.project && s.project !== "{proyecto}" ? ` (${s.project})` : ""}`;
var clip = (x) => `${String(x || "").slice(0, 60)}${String(x || "").length > 60 ? "…" : ""}`;
function describeStep(s) {
	const d = ACTIONS$1[s.action];
	if (!d) return s.action;
	switch (s.action) {
		case "send": return t("phone.auto.step.send", {
			where: where(s),
			prompt: clip(s.prompt)
		});
		case "spawn": return t(s.prompt ? "phone.auto.step.spawnTask" : "phone.auto.step.spawn", {
			name: s.name || "?",
			project: s.project || "?"
		});
		case "notify": return t("phone.auto.step.notify", { text: String(s.text || "").slice(0, 60) });
		case "wait": return t("phone.auto.step.wait", { minutes: s.minutes });
		case "summary": return t("phone.auto.step.summary");
		case "check": return t("phone.auto.step.check", {
			where: where(s),
			states: (s.status || []).map((x) => STATES$2[x] || x).join(t("phone.auto.or")) || "?"
		});
		default: return `${d.label} ${where(s)}`;
	}
}
var TEMPLATES = worded({
	"resumen-dia": {
		scope: "personal",
		build: () => ({
			name: t("phone.tpl.resumen-dia.name"),
			scope: "personal",
			enabled: true,
			trigger: {
				...blankTrigger("schedule"),
				days: [
					0,
					1,
					2,
					3,
					4,
					5,
					6
				],
				at: "18:00"
			},
			steps: [blankStep("summary")]
		})
	},
	"actualizar-pagina": {
		scope: "company",
		build: () => ({
			name: t("phone.tpl.actualizar-pagina.name"),
			scope: "company",
			enabled: true,
			trigger: {
				...blankTrigger("schedule"),
				days: [1],
				at: "09:00"
			},
			steps: [{
				...blankStep("send"),
				session: "master",
				prompt: t("phone.tpl.actualizar-pagina.prompt")
			}]
		})
	}
}, "phone.tpl", ["name", "hint"]);
//#endregion
//#region web/ui/phone-screen.jsx
var joinMeta = (...parts) => parts.map((p) => p == null ? "" : String(p).trim()).filter(Boolean).join(" · ");
function CardStatePill({ status, label }) {
	if (!label) return /* @__PURE__ */ u(StatusPill, {
		status,
		small: true
	});
	return /* @__PURE__ */ u("span", {
		class: `pill c-${STATUS[status].color} sm`,
		children: [
			/* @__PURE__ */ u(Led, {
				state: status,
				size: 7,
				hidden: true
			}),
			" ",
			label
		]
	});
}
var sessionRoute = (project, session) => `/p/${encodeURIComponent(project)}/s/${encodeURIComponent(session || "master")}`;
function PhoneScreen({ title, parent = "/", error, loading, children, actions }) {
	useKeys((key) => {
		if (!key.ctrl && !key.alt && ["q", "`"].includes(key.k)) {
			back(parent);
			return true;
		}
		return false;
	});
	return /* @__PURE__ */ u("div", {
		class: "page fleet-extra",
		children: [
			/* @__PURE__ */ u(BackLink, { parent }),
			/* @__PURE__ */ u("header", {
				class: "page-head",
				children: [/* @__PURE__ */ u("h1", { children: title }), /* @__PURE__ */ u("div", {
					class: "row wrap",
					children: actions
				})]
			}),
			error ? /* @__PURE__ */ u("p", {
				class: "err",
				role: "alert",
				children: error.message
			}) : null,
			loading ? /* @__PURE__ */ u("p", {
				class: "muted",
				role: "status",
				children: t("common.loading")
			}) : null,
			children
		]
	});
}
//#endregion
//#region web/ui/automations.jsx
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
var blank = () => ({
	id: null,
	name: "",
	enabled: true,
	scope: "personal",
	trigger: blankTrigger("schedule"),
	steps: []
});
var TAB_KEY = "gfw.autosTab";
var SEEN_KEY = "gfw.noticesSeen";
var noticesSeen = () => {
	try {
		return Number(localStorage.getItem(SEEN_KEY)) || 0;
	} catch {
		return 0;
	}
};
var markNoticesSeen = (at) => {
	try {
		localStorage.setItem(SEEN_KEY, String(at));
	} catch {}
};
var short = (ts) => (/* @__PURE__ */ new Date(ts * 1e3)).toLocaleString(locale(), {
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit"
});
function Automations({ ctx, projects, id }) {
	const api = useFleet();
	const people = api.hasPeople === true;
	ctx = ctx || api;
	const { data, error, reload } = usePoll(() => api.automations(), 1e4, []);
	const [tab, setTabState] = d(() => {
		try {
			return localStorage.getItem(TAB_KEY) || "mine";
		} catch {
			return "mine";
		}
	});
	const setTab = (t) => {
		setTabState(t);
		try {
			localStorage.setItem(TAB_KEY, t);
		} catch {}
	};
	projects = (projects || data?.fleet || []).map((p) => ({
		...p,
		sessions: Array.isArray(p.sessions) ? p.sessions : data?.fleet?.find((x) => x.name === p.name)?.sessions || []
	}));
	const mineOnly = data?.me ? (projects || []).filter((p) => data.me.projects.includes(p.name)) : projects;
	useKeys((key) => {
		if (key.ctrl || key.alt) return false;
		if (key.k === "q" || key.k === "`") {
			back(id ? "/automations" : "/");
			return true;
		}
		if (key.k === "n" && !id) {
			ctx.go("/automations/new");
			return true;
		}
		return false;
	});
	if (id) return /* @__PURE__ */ u(Editor, {
		ctx,
		projects: mineOnly,
		data,
		error,
		id,
		onSaved: reload
	}, id);
	const admin = people && !!data?.me?.admin;
	const all = data?.automations || [];
	const tabs = [
		[
			"mine",
			t("phone.project.mine"),
			all.filter((a) => a.scope === "personal" && a.mine)
		],
		...!data?.capabilities?.scopes || data.capabilities.scopes.includes("company") ? [[
			"company",
			t("phone.autos.company"),
			all.filter((a) => a.scope === "company")
		]] : [],
		...admin ? [[
			"others",
			t("phone.autos.others"),
			all.filter((a) => a.scope === "personal" && !a.mine)
		]] : []
	];
	const cur = tabs.find((t) => t[0] === tab) || tabs[0];
	const list = people ? cur[2] : all;
	const templates = Object.entries(TEMPLATES).filter(([, t]) => (t.scope === "personal" || admin) && (!data?.capabilities?.actions || t.build().steps.every((s) => data.capabilities.actions.includes(s.action))));
	const seenAt = noticesSeen();
	const fresh = (data?.notices || []).filter((n) => n.seen === void 0 ? n.at > seenAt : !n.seen);
	return /* @__PURE__ */ u("div", {
		class: "page autos",
		children: [
			/* @__PURE__ */ u(BackLink, { parent: "/" }),
			/* @__PURE__ */ u("header", {
				class: "page-head",
				children: [/* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("h1", { children: t("phone.nav.automations") }), /* @__PURE__ */ u("p", {
					class: "muted",
					children: t("phone.autos.sub")
				})] }), /* @__PURE__ */ u(Btn, {
					kind: "primary",
					icon: "plus",
					onClick: () => ctx.go("/automations/new"),
					children: t("project.new")
				})]
			}),
			error ? error.status === 404 ? /* @__PURE__ */ u("p", {
				class: "muted",
				children: t("app.notHere")
			}) : /* @__PURE__ */ u("p", {
				class: "err",
				children: error.message
			}) : null,
			fresh.length ? /* @__PURE__ */ u("section", {
				class: "notices",
				children: [fresh.map((n) => /* @__PURE__ */ u("div", {
					class: `notice k-${n.kind}`,
					children: [
						/* @__PURE__ */ u("span", {
							class: "when",
							children: clock(n.at)
						}),
						" ",
						n.text
					]
				}, n.id)), /* @__PURE__ */ u(Btn, {
					kind: "ghost sm",
					onClick: () => {
						markNoticesSeen(fresh[0].at);
						api.automationsSeen?.().then(reload).catch(() => {});
						reload();
					},
					children: t("phone.autos.seen")
				})]
			}) : null,
			/* @__PURE__ */ u("section", {
				class: "templates",
				"aria-label": t("phone.autos.templates"),
				children: templates.map(([k, t]) => /* @__PURE__ */ u("button", {
					class: "tpl",
					onClick: () => ctx.go(`/automations/template-${k}`),
					children: [
						/* @__PURE__ */ u("b", { children: t.name }),
						" ",
						people ? /* @__PURE__ */ u("span", {
							class: `tag${t.scope === "company" ? " team" : ""}`,
							children: SCOPES[t.scope]
						}) : null,
						/* @__PURE__ */ u("span", {
							class: "muted small",
							children: t.hint
						})
					]
				}, k))
			}),
			people ? /* @__PURE__ */ u("div", {
				class: "seg autos-tabs",
				role: "tablist",
				children: tabs.map(([k, label, items]) => /* @__PURE__ */ u("button", {
					role: "tab",
					"aria-selected": cur[0] === k,
					class: cur[0] === k ? "on" : "",
					onClick: () => setTab(k),
					children: [
						label,
						" ",
						/* @__PURE__ */ u("span", {
							class: "muted",
							children: items.length
						})
					]
				}, k))
			}) : null,
			data && !list.length ? /* @__PURE__ */ u("div", {
				class: "empty",
				children: people && cur[0] === "company" ? /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("b", { children: admin ? t("phone.autos.noCompany") : t("phone.autos.noCompanyMine") }), /* @__PURE__ */ u("span", {
					class: "muted",
					children: admin ? t("phone.autos.companyWhoAdmin") : t("phone.autos.companyWho")
				})] }) : people && cur[0] === "others" ? /* @__PURE__ */ u("b", { children: t("phone.autos.noOthers") }) : /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u("b", { children: t("phone.autos.none") }),
					/* @__PURE__ */ u("span", {
						class: "muted",
						children: t("phone.autos.example")
					}),
					/* @__PURE__ */ u(Btn, {
						kind: "primary",
						onClick: () => ctx.go("/automations/new"),
						children: t("phone.autos.createFirst")
					})
				] })
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "auto-list",
				children: list.map((a) => /* @__PURE__ */ u(AutoCard, {
					people,
					a,
					ctx,
					onChange: reload
				}, a.id))
			}),
			(data?.runs || []).length ? /* @__PURE__ */ u("section", {
				class: "runs",
				children: [/* @__PURE__ */ u("h2", { children: t("phone.autos.runs") }), data.runs.map((r, i) => /* @__PURE__ */ u("details", {
					class: "run",
					children: [/* @__PURE__ */ u("summary", { children: [
						/* @__PURE__ */ u("span", {
							class: `run-st s-${r.status}`,
							children: r.status === "ok" ? "✓" : r.status === "skipped" ? "↷" : "✕"
						}),
						/* @__PURE__ */ u("span", {
							class: "when",
							children: clock(r.at)
						}),
						/* @__PURE__ */ u("b", {
							class: "ellipsis",
							children: r.name
						}),
						/* @__PURE__ */ u("span", {
							class: "muted ellipsis grow",
							children: r.status === "skipped" ? t("phone.autos.skipped", { why: r.text }) : r.trigger
						})
					] }), (r.steps || []).map((s, j) => /* @__PURE__ */ u("div", {
						class: `run-step${s.ok ? "" : " bad"}`,
						children: [
							s.halt ? /* @__PURE__ */ u(Icon, { name: "stop" }) : s.ok ? "✓" : "✕",
							" ",
							s.what,
							s.text ? /* @__PURE__ */ u("small", { children: [" — ", s.text] }) : null
						]
					}, j))]
				}, i))]
			}) : null
		]
	});
}
function AutoCard({ a, ctx, people, onChange }) {
	const api = useFleet();
	const [ask, setAsk] = d(false);
	const [busy, setBusy] = d(false);
	const toggle = async () => {
		try {
			await api.saveAutomation({
				...a,
				enabled: !a.enabled
			});
			onChange();
		} catch (e) {
			toast(e.message, "bad");
		}
	};
	const runNow = async () => {
		setBusy(true);
		try {
			const r = await api.runAutomation(a.id);
			toast(r.ok ? t("phone.autos.ran", { name: a.name }) : r.text, r.ok ? "good" : "bad");
			onChange();
		} catch (e) {
			toast(e.message, "bad");
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u("article", {
		class: `auto-card${a.enabled ? "" : " off"}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "auto-top",
				children: [
					/* @__PURE__ */ u("label", {
						class: "switch",
						title: a.enabled ? t("phone.autos.on") : t("phone.autos.off"),
						children: [/* @__PURE__ */ u("input", {
							type: "checkbox",
							checked: a.enabled,
							onChange: toggle,
							disabled: !a.editable && !(a.enabled && a.scope === "personal"),
							"aria-label": t(a.enabled ? "phone.autos.turnOff" : "phone.autos.turnOn", { name: a.name })
						}), /* @__PURE__ */ u("i", {})]
					}),
					/* @__PURE__ */ u("a", {
						class: "auto-name",
						href: `#/automations/${a.id}`,
						children: a.name
					}),
					people ? /* @__PURE__ */ u("span", {
						class: `tag${a.scope === "company" ? " team" : ""}`,
						children: SCOPES[a.scope]
					}) : null,
					people && !a.mine ? /* @__PURE__ */ u("span", {
						class: "muted small",
						children: t("phone.autos.ownedBy", { name: a.ownerName })
					}) : null
				]
			}),
			a.paused && !a.enabled ? /* @__PURE__ */ u("div", {
				class: "notice k-warn",
				children: t("phone.autos.paused", { why: a.paused.why })
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "auto-flow",
				children: [/* @__PURE__ */ u("span", {
					class: "chip-trigger",
					children: [
						/* @__PURE__ */ u(Icon, { name: a.trigger.type === "event" ? "bolt" : "clock" }),
						" ",
						describeTrigger(a.trigger)
					]
				}), a.steps.map((s, i) => /* @__PURE__ */ u("span", {
					class: "chip-step",
					children: [
						/* @__PURE__ */ u("i", { children: "→" }),
						" ",
						/* @__PURE__ */ u(Icon, { name: ACTIONS$1[s.action]?.icon }),
						" ",
						describeStep(s)
					]
				}, i))]
			}),
			/* @__PURE__ */ u("div", {
				class: "auto-foot",
				children: [
					/* @__PURE__ */ u("span", {
						class: "muted small",
						children: joinMeta(a.running ? t("phone.autos.running") : a.nextRun ? t("phone.autos.next", { when: short(a.nextRun) }) : a.trigger.type === "event" && a.enabled ? t("phone.autos.waitingEvent") : a.enabled ? "" : t("phone.autos.off"), a.lastRun ? `${t("phone.autos.last", { when: short(a.lastRun.at) })} ${a.lastRun.ok ? "✓" : "✕"}` : "")
					}),
					/* @__PURE__ */ u("span", { class: "grow" }),
					a.editable ? /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Btn, {
						kind: "ghost sm",
						disabled: busy,
						onClick: runNow,
						children: busy ? t("phone.autos.runningBtn") : /* @__PURE__ */ u(S$1, { children: [
							/* @__PURE__ */ u(Icon, { name: "play" }),
							" ",
							t("phone.autos.tryNow")
						] })
					}), /* @__PURE__ */ u(Btn, {
						kind: "ghost sm",
						onClick: () => ctx.go(`/automations/${a.id}`),
						children: t("phone.autos.edit")
					})] }) : /* @__PURE__ */ u(Btn, {
						kind: "ghost sm",
						onClick: () => ctx.go(`/automations/${a.id}`),
						children: t("phone.autos.view")
					}),
					a.editable || a.scope === "personal" ? /* @__PURE__ */ u(Btn, {
						kind: "ghost sm",
						onClick: () => setAsk(true),
						"aria-label": t("phone.vp.delete", { name: a.name }),
						children: /* @__PURE__ */ u(Icon, { name: "close" })
					}) : null
				]
			}),
			ask ? /* @__PURE__ */ u(Confirm, {
				title: t("phone.autos.delTitle"),
				danger: true,
				action: t("common.delete"),
				body: /* @__PURE__ */ u("p", { children: [
					t("phone.autos.delBody.a"),
					/* @__PURE__ */ u("b", { children: a.name }),
					t("phone.autos.delBody.b")
				] }),
				onYes: async () => {
					await api.deleteAutomation(a.id);
					onChange();
				},
				onClose: () => setAsk(false)
			}) : null
		]
	});
}
function Editor({ ctx, projects, data, error, id, onSaved }) {
	const api = useFleet();
	const people = api.hasPeople === true;
	const tpl = id.startsWith("template-") ? TEMPLATES[id.slice(9)] : null;
	const fresh = id === "new" || !!tpl;
	const existing = !fresh ? data?.automations?.find((a) => a.id === id) : null;
	const [draft, setDraft] = d(null);
	const [tab, setTab] = d("edit");
	const [saving, setSaving] = d(false);
	h(() => {
		if (!draft && (fresh || existing)) setDraft(existing ? structuredClone(existing) : tpl ? tpl.build() : blank());
	}, [existing, id]);
	const admin = people && !!data?.me?.admin;
	const readOnly = existing && !existing.editable;
	if (error) return /* @__PURE__ */ u("div", {
		class: "page",
		children: [
			/* @__PURE__ */ u(BackLink, { parent: "/automations" }),
			/* @__PURE__ */ u("p", {
				class: "err",
				role: "alert",
				children: error.message
			}),
			/* @__PURE__ */ u(Btn, {
				onClick: onSaved,
				children: t("phone.retry")
			})
		]
	});
	if (!draft || !data) return /* @__PURE__ */ u("div", {
		class: "page",
		children: /* @__PURE__ */ u("p", {
			class: "muted",
			children: data ? t("phone.autos.notFound") : t("common.loading")
		})
	});
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
	const insert = (action, at) => setDraft((d) => {
		const steps = [...d.steps];
		steps.splice(at ?? steps.length, 0, blankStep(action));
		return {
			...d,
			steps
		};
	});
	const move = (from, to) => setDraft((d) => {
		const steps = [...d.steps];
		const [s] = steps.splice(from, 1);
		steps.splice(to > from ? to - 1 : to, 0, s);
		return {
			...d,
			steps
		};
	});
	const remove = (i) => setDraft((d) => ({
		...d,
		steps: d.steps.filter((_, j) => j !== i)
	}));
	const save = async () => {
		setSaving(true);
		try {
			const r = await api.saveAutomation(draft);
			toast(t(r.automation.enabled ? "phone.autos.saved" : "phone.autos.savedOff", { name: r.automation.name }), "good");
			onSaved();
			back("/automations");
		} catch (e) {
			toast(e.message, "bad");
		} finally {
			setSaving(false);
		}
	};
	const isEvent = draft.trigger.type === "event";
	return /* @__PURE__ */ u("div", {
		class: "page autos-edit",
		children: [
			/* @__PURE__ */ u("header", {
				class: "page-head",
				children: [/* @__PURE__ */ u("div", {
					class: "grow",
					children: [/* @__PURE__ */ u(BackLink, { parent: "/automations" }), /* @__PURE__ */ u("input", {
						class: "auto-title",
						placeholder: t("phone.autos.namePh"),
						value: draft.name,
						onInput: (e) => set({ name: e.currentTarget.value }),
						"aria-label": t("auth.name")
					})]
				}), /* @__PURE__ */ u("div", {
					class: "row wrap",
					children: [
						people ? admin && !readOnly ? /* @__PURE__ */ u(Select, {
							class: "scope-pick",
							value: draft.scope,
							onChange: (v) => set({ scope: v }),
							"aria-label": t("phone.autos.scope"),
							options: [{
								value: "personal",
								label: t("phone.autos.scopePersonal")
							}, {
								value: "company",
								label: t("phone.autos.scopeCompany")
							}]
						}) : /* @__PURE__ */ u("span", {
							class: `tag${draft.scope === "company" ? " team" : ""}`,
							"aria-label": t("phone.autos.scope"),
							children: SCOPES[draft.scope]
						}) : null,
						/* @__PURE__ */ u("label", {
							class: "switch-l",
							children: [
								/* @__PURE__ */ u("span", {
									class: "switch",
									children: [/* @__PURE__ */ u("input", {
										type: "checkbox",
										checked: draft.enabled,
										onChange: (e) => set({ enabled: e.currentTarget.checked })
									}), /* @__PURE__ */ u("i", {})]
								}),
								" ",
								t("phone.autos.on")
							]
						}),
						/* @__PURE__ */ u(Btn, {
							kind: "primary",
							disabled: saving || readOnly,
							onClick: save,
							children: saving ? t("phone.common.saving") : t("common.save")
						})
					]
				})]
			}),
			readOnly ? /* @__PURE__ */ u("p", {
				class: "notice k-warn",
				children: !people ? t("phone.autoReadOnly") : existing.scope === "company" ? t("phone.autos.roCompany") : t("phone.autos.roPersonal", { name: existing.ownerName })
			}) : null,
			existing?.paused && !existing.enabled ? /* @__PURE__ */ u("p", {
				class: "notice k-warn",
				children: t("phone.autos.paused", { why: existing.paused.why })
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "tabs-m",
				role: "tablist",
				children: [/* @__PURE__ */ u("button", {
					class: tab === "edit" ? "on" : "",
					onClick: () => setTab("edit"),
					children: t("phone.autos.editor")
				}), /* @__PURE__ */ u("button", {
					class: tab === "ai" ? "on" : "",
					onClick: () => setTab("ai"),
					children: ["✦ ", t("phone.autos.askAI")]
				})]
			}),
			/* @__PURE__ */ u("div", {
				class: `builder show-${tab}`,
				children: [
					/* @__PURE__ */ u(Palette, {
						capabilities: data?.capabilities,
						onAdd: (a) => insert(a),
						onTrigger: (t) => setTrigger(blankTrigger(t))
					}),
					/* @__PURE__ */ u("div", {
						class: "flow",
						"aria-label": t("phone.autos.flow"),
						children: [
							/* @__PURE__ */ u(TriggerBlock, {
								capabilities: data?.capabilities,
								t: draft.trigger,
								projects,
								onChange: setTrigger,
								onType: (t) => set({ trigger: blankTrigger(t) })
							}),
							draft.steps.map((s, i) => /* @__PURE__ */ u("div", {
								class: "flow-item",
								children: [/* @__PURE__ */ u(Drop, {
									at: i,
									onAdd: insert,
									onMove: move
								}), /* @__PURE__ */ u(StepBlock, {
									capabilities: data?.capabilities,
									s,
									i,
									n: draft.steps.length,
									isEvent,
									projects,
									onChange: (p) => setStep(i, p),
									onRemove: () => remove(i),
									onMove: move
								})]
							}, i)),
							/* @__PURE__ */ u(Drop, {
								at: draft.steps.length,
								onAdd: insert,
								onMove: move,
								last: true,
								empty: !draft.steps.length
							})
						]
					}),
					/* @__PURE__ */ u(AIPanel, {
						draft,
						onDraft: (a) => setDraft((d) => ({
							...d,
							...a,
							id: d.id,
							scope: d.scope,
							enabled: d.enabled
						}))
					})
				]
			})
		]
	});
}
function Palette({ capabilities, onAdd, onTrigger }) {
	const drag = (e, kind, v) => {
		e.dataTransfer.setData("text/plain", `${kind}:${v}`);
		e.dataTransfer.effectAllowed = "copy";
	};
	return /* @__PURE__ */ u("aside", {
		class: "palette",
		"aria-label": t("phone.autos.blocks"),
		children: [
			/* @__PURE__ */ u("h3", { children: t("phone.autos.triggers") }),
			/* @__PURE__ */ u("button", {
				class: "blk trig",
				draggable: true,
				onDragStart: (e) => drag(e, "trigger", "schedule"),
				onClick: () => onTrigger("schedule"),
				children: [
					/* @__PURE__ */ u(Icon, { name: "clock" }),
					" ",
					t("phone.autos.schedule")
				]
			}),
			/* @__PURE__ */ u("button", {
				class: "blk trig",
				draggable: true,
				onDragStart: (e) => drag(e, "trigger", "event"),
				onClick: () => onTrigger("event"),
				children: [
					/* @__PURE__ */ u(Icon, { name: "bolt" }),
					" ",
					t("phone.autos.sessionEvent")
				]
			}),
			/* @__PURE__ */ u("h3", { children: t("phone.autos.actions") }),
			Object.entries(ACTIONS$1).filter(([k]) => !capabilities?.actions || capabilities.actions.includes(k)).map(([k, d]) => /* @__PURE__ */ u("button", {
				class: `blk${d.danger ? " danger" : ""}`,
				draggable: true,
				onDragStart: (e) => drag(e, "action", k),
				onClick: () => onAdd(k),
				title: t("phone.autos.dragHint"),
				children: [
					/* @__PURE__ */ u("span", {
						class: "blk-ico",
						children: /* @__PURE__ */ u(Icon, { name: d.icon })
					}),
					" ",
					d.label
				]
			}, k)),
			/* @__PURE__ */ u("p", {
				class: "muted small",
				children: t("phone.autos.dragHelp")
			})
		]
	});
}
function Drop({ at, onAdd, onMove, last, empty }) {
	const [over, setOver] = d(false);
	const onDrop = (e) => {
		e.preventDefault();
		setOver(false);
		const [kind, v] = e.dataTransfer.getData("text/plain").split(":");
		if (kind === "action" && ACTIONS$1[v]) onAdd(v, at);
		if (kind === "move") onMove(Number(v), at);
	};
	return /* @__PURE__ */ u("div", {
		class: `drop${over ? " over" : ""}${last ? " last" : ""}${empty ? " empty" : ""}`,
		onDragOver: (e) => {
			e.preventDefault();
			setOver(true);
		},
		onDragLeave: () => setOver(false),
		onDrop,
		children: empty ? t("phone.autos.dropEmpty") : last ? `＋ ${t("phone.autos.dropLast")}` : null
	});
}
function TriggerBlock({ capabilities, t: t$6, projects, onChange, onType }) {
	const [over, setOver] = d(false);
	const sessions = (projects || []).find((p) => p.name === t$6.project)?.sessions || [];
	return /* @__PURE__ */ u("section", {
		class: `node trigger${over ? " over" : ""}`,
		onDragOver: (e) => {
			e.preventDefault();
			setOver(true);
		},
		onDragLeave: () => setOver(false),
		onDrop: (e) => {
			e.preventDefault();
			setOver(false);
			const [k, v] = e.dataTransfer.getData("text/plain").split(":");
			if (k === "trigger") onType(v);
		},
		children: [
			/* @__PURE__ */ u("header", { children: [/* @__PURE__ */ u("span", {
				class: "node-k",
				children: t("phone.autos.when")
			}), /* @__PURE__ */ u("div", {
				class: "seg",
				children: [/* @__PURE__ */ u("button", {
					class: t$6.type === "schedule" ? "on" : "",
					onClick: () => t$6.type !== "schedule" && onType("schedule"),
					children: [
						/* @__PURE__ */ u(Icon, { name: "clock" }),
						" ",
						t("phone.autos.schedule")
					]
				}), /* @__PURE__ */ u("button", {
					class: t$6.type === "event" ? "on" : "",
					onClick: () => t$6.type !== "event" && onType("event"),
					children: [
						/* @__PURE__ */ u(Icon, { name: "bolt" }),
						" ",
						t("phone.autos.event")
					]
				})]
			})] }),
			t$6.type === "schedule" ? /* @__PURE__ */ u("div", {
				class: "node-body",
				children: [
					/* @__PURE__ */ u("div", {
						class: "seg sm",
						children: [
							/* @__PURE__ */ u("button", {
								class: t$6.mode === "days" ? "on" : "",
								onClick: () => onChange({ mode: "days" }),
								children: t("phone.autos.someDays")
							}),
							/* @__PURE__ */ u("button", {
								class: t$6.mode === "once" ? "on" : "",
								onClick: () => onChange({ mode: "once" }),
								children: t("phone.autos.once")
							}),
							/* @__PURE__ */ u("button", {
								class: t$6.mode === "every" ? "on" : "",
								onClick: () => onChange({ mode: "every" }),
								children: t("phone.autos.everySoOften")
							})
						]
					}),
					t$6.mode === "days" ? /* @__PURE__ */ u("div", {
						class: "days",
						role: "group",
						"aria-label": t("phone.autos.days"),
						children: [
							1,
							2,
							3,
							4,
							5,
							6,
							0
						].map((d) => /* @__PURE__ */ u("button", {
							class: t$6.days.includes(d) ? "on" : "",
							"aria-pressed": t$6.days.includes(d),
							onClick: () => onChange({ days: t$6.days.includes(d) ? t$6.days.filter((x) => x !== d) : [...t$6.days, d] }),
							children: DAY_NAMES[d]
						}, d))
					}) : null,
					t$6.mode === "once" ? /* @__PURE__ */ u("label", {
						class: "field",
						children: [/* @__PURE__ */ u("span", { children: t("phone.autos.date") }), /* @__PURE__ */ u("input", {
							type: "date",
							value: t$6.date,
							onInput: (e) => onChange({ date: e.currentTarget.value })
						})]
					}) : null,
					t$6.mode !== "every" ? /* @__PURE__ */ u("label", {
						class: "field",
						children: [/* @__PURE__ */ u("span", { children: t("phone.autos.time") }), /* @__PURE__ */ u("input", {
							type: "time",
							value: t$6.at,
							onInput: (e) => onChange({ at: e.currentTarget.value })
						})]
					}) : /* @__PURE__ */ u(Select, {
						label: t("phone.autos.every"),
						value: t$6.minutes,
						onChange: (v) => onChange({ minutes: Number(v) }),
						options: EVERY.map((m) => ({
							value: m,
							label: everyWords(m)
						}))
					})
				]
			}) : /* @__PURE__ */ u("div", {
				class: "node-body",
				children: [
					/* @__PURE__ */ u(Select, {
						label: t("phone.autos.whenSession"),
						value: t$6.event,
						onChange: (v) => onChange({ event: v }),
						options: Object.entries(EVENTS$1).filter(([k]) => !capabilities?.events || capabilities.events.includes(k)).map(([k, d]) => ({
							value: k,
							label: `${d.label} (${d.hint})`
						}))
					}),
					/* @__PURE__ */ u("div", {
						class: "row wrap",
						children: [/* @__PURE__ */ u(Select, {
							field: "field grow",
							label: t("phone.autos.whichProject"),
							value: t$6.project,
							onChange: (v) => onChange({
								project: v,
								session: "*"
							}),
							options: [{
								value: "*",
								label: t("phone.autos.anyProject")
							}, ...(projects || []).map((p) => ({
								value: p.name,
								label: p.name
							}))]
						}), /* @__PURE__ */ u(Select, {
							field: "field grow",
							label: t("phone.autos.whichSession"),
							value: t$6.session,
							onChange: (v) => onChange({ session: v }),
							disabled: t$6.project === "*",
							options: [{
								value: "*",
								label: t("phone.autos.any")
							}, ...sessions.map((s) => ({
								value: s.name,
								label: s.lead ? `${s.name} (${t("common.lead")})` : s.name
							}))]
						})]
					}),
					/* @__PURE__ */ u("label", {
						class: "field",
						children: [/* @__PURE__ */ u("span", { children: t("phone.autos.cooldown") }), /* @__PURE__ */ u("input", {
							type: "number",
							min: "1",
							max: "1440",
							value: t$6.cooldown,
							onInput: (e) => onChange({ cooldown: Number(e.currentTarget.value) })
						})]
					})
				]
			}),
			/* @__PURE__ */ u("p", {
				class: "node-say",
				children: describeTrigger(t$6)
			})
		]
	});
}
function StepBlock({ capabilities, s, i, n, isEvent, projects, onChange, onRemove, onMove }) {
	const d$1 = ACTIONS$1[s.action];
	const [grab, setGrab] = d(false);
	const fromEvent = s.project === "{proyecto}";
	const sessions = (projects || []).find((p) => p.name === s.project)?.sessions || [];
	const has = (f) => d$1.needs.includes(f) || d$1.optional?.includes(f);
	return /* @__PURE__ */ u("section", {
		class: `node step${d$1.danger ? " danger" : ""}${grab ? " grab" : ""}`,
		draggable: grab,
		onDragStart: (e) => {
			e.dataTransfer.setData("text/plain", `move:${i}`);
			e.dataTransfer.effectAllowed = "move";
		},
		onDragEnd: () => setGrab(false),
		children: [/* @__PURE__ */ u("header", { children: [
			/* @__PURE__ */ u("span", {
				class: "handle",
				title: t("phone.autos.dragMove"),
				onMouseDown: () => setGrab(true),
				onMouseUp: () => setGrab(false),
				children: "⋮⋮"
			}),
			/* @__PURE__ */ u("span", {
				class: "node-k",
				children: [
					i + 1,
					". ",
					/* @__PURE__ */ u(Icon, { name: d$1.icon }),
					" ",
					d$1.label
				]
			}),
			/* @__PURE__ */ u("span", { class: "grow" }),
			/* @__PURE__ */ u("button", {
				class: "icon-btn",
				disabled: i === 0,
				onClick: () => onMove(i, i - 1),
				"aria-label": t("phone.autos.up"),
				children: "↑"
			}),
			/* @__PURE__ */ u("button", {
				class: "icon-btn",
				disabled: i === n - 1,
				onClick: () => onMove(i, i + 2),
				"aria-label": t("phone.autos.down"),
				children: "↓"
			}),
			/* @__PURE__ */ u("button", {
				class: "icon-btn",
				onClick: onRemove,
				"aria-label": t("phone.autos.removeStep"),
				children: "✕"
			})
		] }), /* @__PURE__ */ u("div", {
			class: "node-body",
			children: [
				has("project") ? /* @__PURE__ */ u("div", {
					class: "row wrap",
					children: [
						/* @__PURE__ */ u(Select, {
							field: "field grow",
							label: t("phone.autos.project"),
							value: s.project,
							onChange: (v) => {
								const keep = (projects || []).find((p) => p.name === v)?.sessions.some((x) => x.name === s.session);
								onChange(v === "{proyecto}" ? {
									project: v,
									session: "{sesion}"
								} : {
									project: v,
									session: keep ? s.session : ""
								});
							},
							options: [
								{
									value: "",
									label: t("phone.autos.choose")
								},
								...isEvent ? [{
									value: "{proyecto}",
									label: t("phone.autos.eventProject")
								}] : [],
								...(projects || []).map((p) => ({
									value: p.name,
									label: p.name
								}))
							]
						}),
						has("session") ? /* @__PURE__ */ u(Select, {
							field: "field grow",
							label: t("phone.autos.session"),
							value: s.session,
							onChange: (v) => onChange({ session: v }),
							disabled: !s.project,
							options: [
								{
									value: "",
									label: t("phone.autos.choose")
								},
								...isEvent ? [{
									value: "{sesion}",
									label: t("phone.auto.step.eventSession")
								}] : [],
								...!fromEvent ? sessions.map((x) => ({
									value: x.name,
									label: x.lead ? `${x.name} (${t("common.lead")})` : x.name
								})) : []
							]
						}) : null,
						has("name") ? /* @__PURE__ */ u("label", {
							class: "field grow",
							children: [/* @__PURE__ */ u("span", { children: t("phone.autos.newName") }), /* @__PURE__ */ u("input", {
								value: s.name,
								placeholder: t("phone.autoNameExample"),
								onInput: (e) => onChange({ name: e.currentTarget.value })
							})]
						}) : null
					]
				}) : null,
				has("prompt") ? /* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: s.action === "send" ? t("sched.message") : s.action === "spawn" ? t("phone.autos.firstTask") : t("phone.autos.resumeMsg") }), /* @__PURE__ */ u("textarea", {
						rows: 3,
						value: s.prompt,
						placeholder: t("phone.autos.vars"),
						onInput: (e) => onChange({ prompt: e.currentTarget.value })
					})]
				}) : null,
				has("branch") ? /* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t("phone.autos.branchOpt") }), /* @__PURE__ */ u("input", {
						value: s.branch,
						onInput: (e) => onChange({ branch: e.currentTarget.value })
					})]
				}) : null,
				s.action === "notify" ? /* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t("phone.autos.noticeText") }), /* @__PURE__ */ u("input", {
						value: s.text,
						placeholder: t("phone.autos.noticePh"),
						onInput: (e) => onChange({ text: e.currentTarget.value })
					})]
				}) : null,
				s.action === "check" ? /* @__PURE__ */ u("div", {
					class: "field",
					children: [
						/* @__PURE__ */ u("span", { children: t("phone.autos.ifNow") }),
						/* @__PURE__ */ u("div", {
							class: "days states",
							role: "group",
							"aria-label": t("phone.autos.states"),
							children: Object.entries(STATES$2).filter(([k]) => !capabilities?.states || capabilities.states.includes(k)).map(([k, label]) => /* @__PURE__ */ u("button", {
								class: s.status.includes(k) ? "on" : "",
								"aria-pressed": s.status.includes(k),
								onClick: () => onChange({ status: s.status.includes(k) ? s.status.filter((x) => x !== k) : [...s.status, k] }),
								children: label
							}, k))
						}),
						/* @__PURE__ */ u("small", {
							class: "muted",
							children: t("phone.autos.checkHint")
						})
					]
				}) : null,
				s.action === "summary" ? /* @__PURE__ */ u("p", {
					class: "muted small",
					children: t("phone.autos.summaryHint")
				}) : null,
				s.action === "wait" ? /* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t("phone.autos.minutes") }), /* @__PURE__ */ u("input", {
						type: "number",
						min: "1",
						max: "60",
						value: s.minutes,
						onInput: (e) => onChange({ minutes: Number(e.currentTarget.value) })
					})]
				}) : null,
				d$1.danger ? /* @__PURE__ */ u("label", {
					class: "check danger",
					children: [/* @__PURE__ */ u("input", {
						type: "checkbox",
						checked: s.confirmed,
						onChange: (e) => onChange({ confirmed: e.currentTarget.checked })
					}), t("phone.autos.confirmStop")]
				}) : null
			]
		})]
	});
}
function AIPanel({ draft, onDraft }) {
	const api = useFleet();
	const [msgs, setMsgs] = d([]);
	const [text, setText] = d("");
	const [busy, setBusy] = d(false);
	const [undo, setUndo] = d(null);
	const end = A(null);
	h(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [msgs, busy]);
	const ask = async () => {
		const t$7 = text.trim();
		if (!t$7 || busy) return;
		const next = [...msgs, {
			role: "user",
			text: t$7
		}];
		setMsgs(next);
		setText("");
		setBusy(true);
		try {
			const has = draft.steps.length || draft.name;
			const r = await api.automationAI(next, has ? {
				name: draft.name,
				trigger: draft.trigger,
				steps: draft.steps
			} : null);
			setMsgs((m) => [...m, {
				role: "ai",
				text: r.reply,
				applied: !!r.automation
			}]);
			if (r.automation) {
				setUndo(structuredClone(draft));
				onDraft(r.automation);
			}
		} catch (e) {
			setMsgs((m) => [...m, {
				role: "ai",
				text: t("phone.autos.aiFailed", { why: e.message }),
				error: true
			}]);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u("aside", {
		class: "ai-panel",
		"aria-label": t("phone.autos.askAI"),
		children: [
			/* @__PURE__ */ u("h3", { children: [
				/* @__PURE__ */ u(Icon, { name: "spark" }),
				" ",
				t("phone.autos.askAI")
			] }),
			/* @__PURE__ */ u("div", {
				class: "ai-msgs",
				children: [
					!msgs.length ? /* @__PURE__ */ u("p", {
						class: "muted small",
						children: t("phone.autos.aiHint")
					}) : null,
					msgs.map((m, i) => /* @__PURE__ */ u("div", {
						class: `ai-msg ${m.role}${m.error ? " error" : ""}`,
						children: [m.text, m.applied ? /* @__PURE__ */ u("small", {
							class: "ai-applied",
							children: [
								"✓ ",
								t("phone.autos.aiApplied"),
								undo && i === msgs.length - 1 ? /* @__PURE__ */ u(S$1, { children: [" · ", /* @__PURE__ */ u("a", {
									href: "#",
									onClick: (e) => {
										e.preventDefault();
										onDraft(undo);
										setUndo(null);
									},
									children: t("phone.autos.undo")
								})] }) : null
							]
						}) : null]
					}, i)),
					busy ? /* @__PURE__ */ u("div", {
						class: "ai-msg ai muted",
						children: t("phone.autos.aiBusy")
					}) : null,
					/* @__PURE__ */ u("div", { ref: end })
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "ai-input",
				children: [/* @__PURE__ */ u("textarea", {
					rows: 2,
					value: text,
					placeholder: t("phone.autos.aiPh"),
					onInput: (e) => setText(e.currentTarget.value),
					onKeyDown: (e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							ask();
						}
					}
				}), /* @__PURE__ */ u(Btn, {
					kind: "primary",
					disabled: busy || !text.trim(),
					onClick: ask,
					children: t("common.send")
				})]
			})
		]
	});
}
//#endregion
//#region web/ui/reviews.jsx
var commitOf = (run) => run.commit ? `${run.commit}${run.dirty ? "*" : ""}` : null;
var reviewRoute = (host, profile, run) => `/reviews/${[
	host || "-",
	profile,
	run
].map(encodeURIComponent).join("/")}`;
function Reviews() {
	const fleet = useFleet();
	const { data, error, loading } = usePoll(() => fleet.reviews(), 5e3, []);
	const [expanded, setExpanded] = useKept("reviews.expanded", []);
	const open = (g, r) => fleet.go(reviewRoute(g.host_key, g.profile, r.id));
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.reviews"),
		error,
		loading,
		children: [
			data === null && !loading && !error ? /* @__PURE__ */ u("p", {
				class: "empty",
				children: t("phone.reviewsOff")
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "extra-grid",
				children: (data?.groups || []).map((g) => /* @__PURE__ */ u("section", { children: [/* @__PURE__ */ u("button", {
					class: `card extra-card s-${g.latest.state?.cls === "ok" ? "green" : g.latest.state?.cls === "bad" ? "red" : "yellow"}`,
					onClick: () => open(g, g.latest),
					children: [
						/* @__PURE__ */ u("span", {
							class: `pill c-${g.latest.state?.cls === "ok" ? "green" : g.latest.state?.cls === "bad" ? "red" : "yellow"}`,
							children: g.latest.state?.label
						}),
						/* @__PURE__ */ u("h3", { children: g.branch || t("phone.noBranch") }),
						/* @__PURE__ */ u("p", { children: joinMeta(g.project, g.host, data.multi ? g.profile : "") }),
						/* @__PURE__ */ u("p", {
							class: "muted",
							children: joinMeta(t(g.latest.kind === "recorded" ? "phone.video" : "phone.stills"), g.latest.steps == null ? null : t("phone.steps", { n: g.latest.steps }), commitOf(g.latest), g.latest.at ? ago((Date.now() - Date.parse(g.latest.at)) / 1e3) : null)
						})
					]
				}), g.earlier?.length ? /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Btn, {
					kind: "ghost sm",
					"aria-expanded": expanded.includes(g.key),
					onClick: () => setExpanded((xs) => xs.includes(g.key) ? xs.filter((x) => x !== g.key) : [...xs, g.key]),
					children: t("phone.earlier", { n: g.earlier.length })
				}), expanded.includes(g.key) ? g.earlier.map((r) => /* @__PURE__ */ u(Btn, {
					kind: "ghost",
					onClick: () => open(g, r),
					children: joinMeta(r.state?.label, commitOf(r), r.id)
				}, r.id)) : null] }) : null] }, g.key))
			}),
			data && !data.groups?.length ? /* @__PURE__ */ u("p", {
				class: "empty",
				children: t("phone.noReviews")
			}) : null,
			(data?.missing || []).map((m) => /* @__PURE__ */ u("p", {
				class: "muted",
				children: t("phone.hostMissing", { host: m.host })
			}, m.host_key))
		]
	});
}
function Review({ host = "", profile, run: id }) {
	const fleet = useFleet(), video = A(), writer = A({
		busy: false,
		dirty: false,
		timer: 0,
		run: null,
		verdict: {}
	});
	const [run, setRun] = d(null), [error, setError] = d(null), [save, setSave] = d(""), [verdict, setVerdict] = d({});
	const [chapter, setChapter] = d(0);
	h(() => {
		let live = true;
		const w = {
			busy: false,
			dirty: false,
			timer: 0,
			run: null,
			verdict: {},
			live: true
		};
		writer.current = w;
		setRun(null);
		setError(null);
		setSave("");
		setChapter(0);
		w.flush = async () => {
			clearTimeout(w.timer);
			w.timer = 0;
			if (w.busy || !w.dirty || !w.run) return;
			w.busy = true;
			w.dirty = false;
			const v = w.verdict;
			const body = {
				host,
				profile,
				run: id,
				...w.run.kind === "recorded" ? {
					flow: v.flow?.v ? v.flow : { v: "" },
					chapters: v.chapters || {}
				} : { state: Object.fromEntries(Object.entries(v).filter(([, x]) => x?.v)) }
			};
			try {
				await fleet.saveReview(body);
				if (w.live) {
					setSave(t("phone.saved"));
					setError(null);
				}
			} catch (e) {
				w.dirty = true;
				if (w.live) {
					setSave(t("phone.saveFailed"));
					setError(e);
				}
				w.busy = false;
				return;
			}
			w.busy = false;
			if (w.dirty) return w.flush();
		};
		fleet.review(profile, id, host).then((j) => {
			if (!live) return;
			w.run = j.run;
			w.verdict = j.run.verdict || {};
			setRun(j.run);
			setVerdict(w.verdict);
		}, (e) => {
			if (live) setError(e);
		});
		return () => {
			live = false;
			w.live = false;
			clearTimeout(w.timer);
			w.flush();
		};
	}, [
		profile,
		id,
		host
	]);
	const edit = (fn, delay = 0) => {
		const w = writer.current;
		w.verdict = fn(w.verdict);
		w.dirty = true;
		setVerdict(w.verdict);
		setSave(t("phone.saving"));
		clearTimeout(w.timer);
		if (delay) w.timer = setTimeout(w.flush, delay);
		else w.flush();
	};
	const seek = (n) => {
		const next = Math.max(0, Math.min((run?.steps?.length || 1) - 1, n));
		setChapter(next);
		const step = run?.steps?.[next];
		if (video.current && step) video.current.currentTime = step.at ?? step.start ?? step.t ?? 0;
	};
	const flow = (v) => edit((x) => ({
		...x,
		flow: {
			...x.flow,
			v: x.flow?.v === v ? "" : v
		}
	}));
	useKeys((key) => {
		if (key.ctrl || key.alt || !run) return false;
		if (key.k === " " && video.current) {
			video.current.paused ? video.current.play().catch(() => {}) : video.current.pause();
			return true;
		}
		if (key.k === "ArrowLeft" || key.k === "ArrowRight") {
			seek(chapter + (key.k === "ArrowLeft" ? -1 : 1));
			return true;
		}
		if (run.kind === "recorded" && ["a", "r"].includes(key.k)) {
			flow(key.k === "a" ? "approve" : "reject");
			return true;
		}
		return false;
	});
	const note = (label, value, change) => /* @__PURE__ */ u("label", {
		class: "field",
		children: [/* @__PURE__ */ u("span", { children: label }), /* @__PURE__ */ u("textarea", {
			rows: 2,
			value: value || "",
			onInput: (e) => change(e.currentTarget.value),
			onBlur: () => writer.current.flush()
		})]
	});
	const stepEdit = (n, patch, delay = 0) => edit((x) => ({
		...x,
		[n]: {
			...x[n],
			...patch
		}
	}), delay);
	const steps = run?.steps || [];
	const problem = steps.filter((s) => verdict[s.n]?.v === "problem").length;
	const unmarked = steps.filter((s) => !verdict[s.n]?.v).length;
	const flagged = steps.filter((s) => s.notes?.length && !(["ok", "skip"].includes(verdict[s.n]?.v) && verdict[s.n]?.note?.trim())).length;
	const gate = run?.kind === "recorded" ? verdict.flow?.v === "approve" ? "approved" : verdict.flow?.v === "reject" ? "rejected" : "unreviewed" : problem ? "changesNeeded" : unmarked ? "unreviewed" : flagged ? "reasonNeeded" : "approved";
	return /* @__PURE__ */ u(PhoneScreen, {
		title: run?.branch || t("phone.review"),
		parent: "/reviews",
		error,
		loading: !run && !error,
		children: run ? /* @__PURE__ */ u(S$1, { children: [
			/* @__PURE__ */ u("span", {
				class: `pill says c-${gate === "approved" ? "green" : ["rejected", "changesNeeded"].includes(gate) ? "red" : "yellow"}`,
				children: t(`phone.${gate}`)
			}),
			/* @__PURE__ */ u("p", {
				class: "muted",
				children: joinMeta(run.project, run.host, profile, run.provenance?.commit)
			}),
			/* @__PURE__ */ u("p", {
				role: "status",
				children: save
			}),
			save === t("phone.saveFailed") ? /* @__PURE__ */ u(Btn, {
				onClick: () => writer.current.flush(),
				children: t("phone.retry")
			}) : null,
			run.kind === "recorded" ? /* @__PURE__ */ u("div", {
				class: "stack review-verdict",
				children: [
					/* @__PURE__ */ u("video", {
						ref: video,
						class: "review-media",
						src: run.videoSrc,
						controls: true,
						playsInline: true
					}),
					/* @__PURE__ */ u("div", {
						class: "row wrap",
						children: ["approve", "reject"].map((v) => /* @__PURE__ */ u(Btn, {
							kind: verdict.flow?.v === v ? "primary" : "",
							"aria-pressed": verdict.flow?.v === v,
							onClick: () => flow(v),
							children: t(`phone.${v}`)
						}))
					}),
					note(t("phone.reviewNote"), verdict.flow?.note, (text) => edit((x) => ({
						...x,
						flow: {
							...x.flow,
							note: text
						}
					}), 700))
				]
			}) : /* @__PURE__ */ u(Btn, {
				onClick: () => edit((x) => ({
					...x,
					...Object.fromEntries(run.steps.filter((s) => !x[s.n]?.v).map((s) => [s.n, {
						v: "ok",
						note: x[s.n]?.note || ""
					}]))
				})),
				children: t("phone.restOk")
			}),
			(run.steps || []).map((s, i) => /* @__PURE__ */ u("section", {
				class: "review-step stack",
				children: [
					/* @__PURE__ */ u("h2", { children: [
						s.n,
						". ",
						s.name
					] }),
					run.kind === "recorded" ? /* @__PURE__ */ u(Btn, {
						onClick: () => seek(i),
						children: t("phone.chapter")
					}) : /* @__PURE__ */ u("img", {
						class: "review-media",
						src: s.src,
						alt: s.name
					}),
					/* @__PURE__ */ u("p", {
						class: "muted",
						children: s.url
					}),
					(s.notes || []).map((n, j) => /* @__PURE__ */ u("p", {
						class: "err",
						children: typeof n === "string" ? n : JSON.stringify(n)
					}, j)),
					run.kind !== "recorded" ? /* @__PURE__ */ u("div", {
						class: "row wrap",
						children: [
							"ok",
							"problem",
							"skip"
						].map((v) => /* @__PURE__ */ u(Btn, {
							"aria-pressed": verdict[s.n]?.v === v,
							kind: verdict[s.n]?.v === v ? "primary" : "",
							onClick: () => stepEdit(s.n, { v: verdict[s.n]?.v === v ? "" : v }),
							children: t(`phone.${v}`)
						}))
					}) : null,
					note(t("phone.reviewNote"), run.kind === "recorded" ? verdict.chapters?.[s.n] : verdict[s.n]?.note, (text) => run.kind === "recorded" ? edit((x) => ({
						...x,
						chapters: {
							...x.chapters,
							[s.n]: text
						}
					}), 700) : stepEdit(s.n, { note: text }, 700)),
					s.requests?.length ? /* @__PURE__ */ u("details", { children: [/* @__PURE__ */ u("summary", { children: t("phone.requests", { n: s.requests.length }) }), s.requests.map((r, j) => /* @__PURE__ */ u("p", { children: [
						r.method,
						" ",
						r.status,
						" ",
						r.url
					] }, j))] }) : null
				]
			}, s.n))
		] }) : null
	});
}
//#endregion
//#region web/ui/stacks.jsx
var memberName = (m) => joinMeta(...splitAddr(m.project), m.session);
var keyOf = (m) => JSON.stringify([m.project, m.session]);
function StackPicker({ members = [], onOpen }) {
	const fleet = useFleet();
	const [selected, setSelected] = useKept("stack.members", members), [query, setQuery] = useKept("stack.query", "");
	const { data, error, loading } = usePoll(async () => {
		const p = await fleet.screenProjects();
		return Promise.all((p.projects || []).filter((p) => !p.sessions || p.sessions.total !== 0).map(async (p) => {
			try {
				return {
					...p,
					...await fleet.grid(p.name)
				};
			} catch (error) {
				return {
					...p,
					cards: [],
					error
				};
			}
		}));
	}, 5e3, []);
	const toggle = (m) => setSelected((items) => items.some((x) => keyOf(x) === keyOf(m)) ? items.filter((x) => keyOf(x) !== keyOf(m)) : [...items, m]);
	const open = () => selected.length && (onOpen ? onOpen(selected) : fleet.go(`/stack/${encodeURIComponent(JSON.stringify(selected))}`));
	useKeys((key) => {
		if (!key.ctrl && !key.alt && key.k === "Enter") {
			open();
			return true;
		}
		return false;
	});
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.stacks"),
		error: error || data?.find((p) => p.error)?.error,
		loading,
		actions: /* @__PURE__ */ u(Btn, {
			kind: "primary",
			disabled: !selected.length,
			onClick: open,
			children: t("phone.openStack", { n: selected.length })
		}),
		children: [
			/* @__PURE__ */ u("label", {
				class: "field",
				children: [/* @__PURE__ */ u("span", { children: t("phone.search") }), /* @__PURE__ */ u("input", {
					type: "search",
					value: query,
					onInput: (e) => setQuery(e.currentTarget.value)
				})]
			}),
			(data || []).map((p) => {
				const cards = (p.cards || []).filter((c) => !c.lost && `${p.name} ${c.name} ${c.branch || ""} ${c.msg || ""}`.toLowerCase().includes(query.toLowerCase()));
				return cards.length ? /* @__PURE__ */ u("section", { children: [/* @__PURE__ */ u("h2", { children: joinMeta(splitAddr(p.name)[0], p.host) }), /* @__PURE__ */ u("div", {
					class: "extra-grid",
					children: cards.map((c) => {
						const m = {
							project: p.name,
							session: c.name
						};
						return /* @__PURE__ */ u("label", {
							class: "card extra-card stack-choice",
							children: [
								/* @__PURE__ */ u("input", {
									type: "checkbox",
									checked: selected.some((x) => keyOf(x) === keyOf(m)),
									onChange: () => toggle(m)
								}),
								/* @__PURE__ */ u("h3", { children: c.name }),
								/* @__PURE__ */ u(StatusPill, {
									status: c.status,
									small: true
								}),
								/* @__PURE__ */ u("p", {
									class: "muted",
									children: c.branch
								}),
								/* @__PURE__ */ u("p", { children: c.msg })
							]
						}, c.name);
					})
				})] }, p.name) : null;
			}),
			data && !data.some((p) => p.cards?.some((c) => !c.lost)) ? /* @__PURE__ */ u("p", {
				class: "empty",
				children: t("phone.noSessions")
			}) : null
		]
	});
}
var NARROW = "(max-width: 760px)";
function useNarrow() {
	const q = () => {
		try {
			return matchMedia(NARROW).matches;
		} catch {
			return false;
		}
	};
	const [narrow, setNarrow] = d(q);
	h(() => {
		let m;
		try {
			m = matchMedia(NARROW);
		} catch {
			return;
		}
		const f = () => setNarrow(m.matches);
		m.addEventListener("change", f);
		return () => m.removeEventListener("change", f);
	}, []);
	return narrow;
}
function StackView({ members = [] }) {
	const fleet = useFleet(), [active, setActive] = d(0), narrow = useNarrow();
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.stacks"),
		parent: "/stack-picker",
		actions: /* @__PURE__ */ u(Btn, {
			onClick: () => fleet.go("/stack-picker"),
			children: t("phone.editStack")
		}),
		children: !members.length ? /* @__PURE__ */ u("p", {
			class: "empty",
			children: t("phone.emptyStack")
		}) : /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("div", {
			class: "seg",
			role: "tablist",
			children: members.map((m, i) => /* @__PURE__ */ u("button", {
				role: "tab",
				"aria-selected": active === i,
				class: active === i ? "on" : "",
				onClick: () => setActive(i),
				children: memberName(m)
			}))
		}), /* @__PURE__ */ u("div", {
			class: "stack-columns",
			children: members.map((m, i) => /* @__PURE__ */ u("section", {
				class: `stack-column${i === active ? " stack-active" : ""}`,
				onFocusIn: () => setActive(i),
				children: [/* @__PURE__ */ u("header", {
					class: "row wrap",
					children: [/* @__PURE__ */ u("h2", { children: memberName(m) }), /* @__PURE__ */ u(Btn, {
						onClick: () => fleet.go(sessionRoute(m.project, m.session)),
						children: t("phone.openSession")
					})]
				}), narrow && i !== active ? null : /* @__PURE__ */ u(SessionView, {
					embedded: true,
					quiet: i !== active,
					project: m.project,
					name: m.session,
					onChanged: () => {},
					onGone: () => fleet.go("/stack-picker")
				})]
			}, keyOf(m)))
		})] })
	});
}
//#endregion
//#region web/ui/sign-ins.jsx
function SignInCard({ row, onChanged = () => {} }) {
	const fleet = useFleet(), input = A();
	const [busy, setBusy] = d(false), [result, setResult] = d(""), [done, setDone] = d(false), [now, setNow] = d(Date.now());
	h(() => {
		const timer = setInterval(() => setNow(Date.now()), 1e3);
		return () => {
			clearInterval(timer);
			if (input.current) input.current.value = "";
		};
	}, []);
	const left = Math.max(0, Math.ceil(((Number(row.expires) || 0) - now) / 1e3));
	const pending = row.status === "pending" && left > 0 && !done;
	const account = row.kind === "account";
	const expired = row.kind !== "connector" && (row.status === "expired" || row.status === "pending" && !left);
	const state = done || row.status === "done" ? "ready" : expired ? "expired" : pending || row.status === "needs-login" || row.kind === "connector" && row.status === "pending" ? "need-you" : "failed";
	const status = ["expired", "failed"].includes(state) ? "interrupted" : state;
	const stateLabel = state === "expired" ? t("phone.expired") : state === "failed" ? t("phone.signInFailed") : null;
	const start = async () => {
		setBusy(true);
		try {
			const r = await fleet.startAccountLogin(row.project, row.session, row.sock);
			setResult(r.ok ? t("phone.loginStarted") : t("phone.loginStartFailed"));
			if (r.ok) onChanged();
		} catch {
			setResult(t("phone.loginStartFailed"));
		} finally {
			setBusy(false);
		}
	};
	const finish = async () => {
		let secret = input.current?.value || "";
		if (input.current) input.current.value = "";
		setBusy(true);
		try {
			const r = account ? await fleet.finishAccountLogin(row.project, row.id, secret) : await fleet.finishLogin(row.project, row.id, secret);
			secret = "";
			setResult(t(r.ok ? "phone.loginDone" : "phone.loginFailed"));
			if (r.ok) {
				setDone(true);
				onChanged();
			}
		} catch {
			setResult(t("phone.loginFailed"));
		} finally {
			secret = "";
			if (input.current) input.current.value = "";
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u("article", {
		class: `card extra-card s-${STATUS[status].color} login-card`,
		"data-login": row.id,
		children: [
			/* @__PURE__ */ u(CardStatePill, {
				status,
				label: stateLabel
			}),
			/* @__PURE__ */ u("h3", { children: row.provider }),
			/* @__PURE__ */ u("p", { children: joinMeta(row.server, row.session, row.host || t("phone.thisHost"), row.project) }),
			account ? /* @__PURE__ */ u("p", {
				class: "login-profile",
				children: row.profile
			}) : null,
			row.first_site ? /* @__PURE__ */ u("p", {
				class: "err",
				children: t("phone.firstSite")
			}) : null,
			row.kind === "connector" ? /* @__PURE__ */ u("p", { children: joinMeta("claude.ai", row.connector) }) : null,
			account && row.status === "needs-login" ? /* @__PURE__ */ u(Btn, {
				disabled: busy,
				onClick: start,
				children: t("phone.signIn")
			}) : null,
			(pending || row.kind === "connector") && /^https?:\/\//.test(row.authorize || "") ? /* @__PURE__ */ u("a", {
				class: "btn",
				href: row.authorize,
				target: "_blank",
				rel: "noopener noreferrer",
				referrerPolicy: "no-referrer",
				children: t(row.kind === "connector" ? "phone.openConnector" : "phone.open")
			}) : null,
			pending && (account || row.kind === "loopback") ? /* @__PURE__ */ u(S$1, { children: [
				/* @__PURE__ */ u("label", {
					class: "field",
					children: [/* @__PURE__ */ u("span", { children: t(account ? "phone.code" : "phone.callback") }), /* @__PURE__ */ u("input", {
						ref: input,
						type: account ? "password" : "text",
						autoComplete: "off",
						autoCapitalize: "off",
						spellcheck: false
					})]
				}),
				/* @__PURE__ */ u(Btn, {
					disabled: busy || !left,
					onClick: finish,
					children: t("phone.finishLogin")
				}),
				/* @__PURE__ */ u("small", {
					class: "muted",
					children: t("phone.expires", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })
				})
			] }) : null,
			!pending && row.kind !== "connector" && row.status === "pending" && !done ? /* @__PURE__ */ u("p", { children: t("phone.expired") }) : null,
			/* @__PURE__ */ u("p", {
				role: "status",
				children: result || (done ? t("phone.loginDone") : "")
			})
		]
	});
}
function PendingSignIns({ empty = false }) {
	const fleet = useFleet();
	const { data, error, reload } = usePoll(() => fleet.pendingSignIns(), 5e3, []);
	const items = data?.items || [];
	return /* @__PURE__ */ u(S$1, { children: [
		error ? /* @__PURE__ */ u("p", {
			class: "err",
			role: "alert",
			children: t("phone.loginReadFailed")
		}) : null,
		/* @__PURE__ */ u("div", {
			class: "extra-grid",
			children: items.map((r) => /* @__PURE__ */ u(SignInCard, {
				row: r,
				onChanged: reload
			}, r.id))
		}),
		empty && data && !items.length ? /* @__PURE__ */ u("p", {
			class: "empty",
			children: t("phone.noSignIns")
		}) : null
	] });
}
function SignIns() {
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.signIns"),
		children: /* @__PURE__ */ u(PendingSignIns, { empty: true })
	});
}
//#endregion
//#region web/ui/held.jsx
function HeldCard({ row }) {
	const fleet = useFleet();
	return /* @__PURE__ */ u("article", {
		class: "card extra-card s-yellow",
		children: [
			/* @__PURE__ */ u(CardStatePill, {
				status: "need-you",
				label: t("phone.cardHeld")
			}),
			/* @__PURE__ */ u("h3", { children: joinMeta(splitAddr(row.project)[0], row.session || "master") }),
			/* @__PURE__ */ u("p", { children: row.text }),
			/* @__PURE__ */ u("p", {
				class: "muted",
				children: joinMeta(row.host, typeof row.reason === "string" ? row.reason : row.reason?.text, row.since ? ago(Date.now() / 1e3 - row.since) : "")
			}),
			/* @__PURE__ */ u(Btn, {
				onClick: () => fleet.go(sessionRoute(row.project, row.session)),
				children: t("phone.openHeld")
			})
		]
	});
}
function Held({ row, project, id }) {
	const fleet = useFleet();
	const { data, error, loading } = usePoll(() => row ? Promise.resolve({ items: [row] }) : fleet.waiting(), 5e3, [
		row,
		project,
		id
	]);
	const rows = (data?.items || []).filter((r) => r.state === "held" && (!project || r.project === project) && (!id || String(r.id) === String(id)));
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.held"),
		parent: "/queue",
		error,
		loading,
		children: [
			rows.length ? /* @__PURE__ */ u("p", {
				class: "muted",
				children: t("phone.heldHint")
			}) : null,
			/* @__PURE__ */ u("div", {
				class: "extra-grid",
				children: rows.map((r) => /* @__PURE__ */ u(HeldCard, { row: r }, `${r.project}/${r.id}`))
			}),
			data && !rows.length ? /* @__PURE__ */ u("p", {
				class: "empty",
				children: t("phone.nothingWaiting")
			}) : null
		]
	});
}
//#endregion
//#region web/ui/queue.jsx
var replyText = (row, text) => `Re your ledger item ${row.id}: "${row.text}"\n\n${String(text || "").trim()}`;
function Queue() {
	const fleet = useFleet();
	const { data, error, loading, reload } = usePoll(() => fleet.waiting(), 5e3, []);
	const [row, setRow] = d(null), [drafts, setDrafts] = d({}), [busy, setBusy] = d(false), [failure, setFailure] = d("");
	const keyOf = (r) => `${r.project}/${r.id}`;
	const text = row ? drafts[keyOf(row)] || "" : "";
	const setText = (v) => {
		const k = keyOf(row);
		setDrafts((d) => ({
			...d,
			[k]: v
		}));
	};
	const send = async () => {
		if (!text.trim() || busy) return;
		setBusy(true);
		setFailure("");
		const k = keyOf(row);
		try {
			await fleet.act("fleet_send", {
				project: row.project,
				session: "master",
				prompt: replyText(row, text)
			});
			setRow(null);
			setDrafts((d) => {
				const n = { ...d };
				delete n[k];
				return n;
			});
			reload();
		} catch (e) {
			setFailure(e.message);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.queue"),
		error,
		loading,
		children: [
			/* @__PURE__ */ u(PendingSignIns, {}),
			/* @__PURE__ */ u("div", {
				class: "extra-grid",
				children: (data?.items || []).map((r) => r.state === "held" ? /* @__PURE__ */ u(HeldCard, { row: r }, `${r.project}/${r.id}`) : /* @__PURE__ */ u("article", {
					class: "card extra-card s-yellow",
					children: [
						/* @__PURE__ */ u("span", {
							class: "pill c-yellow",
							children: ["waiting", "replied"].includes(r.state) ? t(`phone.queueState.${r.state}`) : r.state
						}),
						/* @__PURE__ */ u("h3", { children: joinMeta(splitAddr(r.project)[0], r.id == null ? null : `#${r.id}`) }),
						/* @__PURE__ */ u("p", { children: r.text }),
						/* @__PURE__ */ u("p", {
							class: "muted",
							children: joinMeta(r.host, typeof r.reason === "string" ? r.reason : r.reason?.text)
						}),
						/* @__PURE__ */ u(Btn, {
							onClick: () => {
								setRow(r);
								setFailure("");
							},
							children: t("phone.reply")
						})
					]
				}, `${r.project}/${r.id}`))
			}),
			data && !data.items?.length ? /* @__PURE__ */ u("p", {
				class: "empty",
				children: t("phone.nothingWaiting")
			}) : null,
			row ? /* @__PURE__ */ u(Modal, {
				title: joinMeta(t("phone.reply"), row.project, row.id == null ? null : `#${row.id}`),
				onClose: () => !busy && setRow(null),
				children: [
					/* @__PURE__ */ u("p", { children: row.text }),
					/* @__PURE__ */ u("p", {
						class: "muted",
						children: t("phone.replyHint")
					}),
					/* @__PURE__ */ u("label", {
						class: "field",
						children: [/* @__PURE__ */ u("span", { children: t("phone.reply") }), /* @__PURE__ */ u("textarea", {
							rows: 4,
							value: text,
							onInput: (e) => setText(e.currentTarget.value)
						})]
					}),
					failure ? /* @__PURE__ */ u("p", {
						class: "err",
						role: "alert",
						children: failure
					}) : null,
					/* @__PURE__ */ u(Btn, {
						kind: "primary",
						disabled: busy || !text.trim(),
						onClick: send,
						children: t("common.send")
					})
				]
			}) : null
		]
	});
}
//#endregion
//#region web/ui/search.jsx
function SearchInput({ value, onChange, onOpen, inputRef }) {
	const fleet = useFleet();
	return /* @__PURE__ */ u("form", {
		class: "extra-search",
		role: "search",
		onSubmit: (e) => {
			e.preventDefault();
			onOpen ? onOpen() : fleet.go(`/search?q=${encodeURIComponent(value || "")}`);
		},
		children: [/* @__PURE__ */ u("input", {
			ref: inputRef,
			type: "search",
			"aria-label": t("phone.search"),
			placeholder: t("phone.searchHint"),
			value: value || "",
			onInput: (e) => onChange(e.currentTarget.value)
		}), /* @__PURE__ */ u(Btn, {
			onClick: () => onOpen ? onOpen() : fleet.go(`/search?q=${encodeURIComponent(value || "")}`),
			children: t("phone.search")
		})]
	});
}
function Search({ query = "" }) {
	const fleet = useFleet(), field = A();
	const [openError, setOpenError] = d(null);
	const [q, setQ] = useKept("search.query", query);
	const { data, error, loading } = usePoll(() => fleet.screenProjects(), 5e3, []);
	const { data: grids, error: gridError, loading: gridLoading } = usePoll(async () => !q.trim() ? [] : Promise.all((data?.projects || []).filter((p) => !p.sessions || p.sessions.total !== 0).map(async (p) => {
		try {
			return {
				project: p,
				...await fleet.grid(p.name)
			};
		} catch (error) {
			return {
				project: p,
				cards: [],
				error
			};
		}
	})), 5e3, [data, !!q.trim()]);
	const needle = q.trim().toLocaleLowerCase();
	const projects = (data?.projects || []).filter((p) => !needle || `${p.name} ${p.path || ""}`.toLocaleLowerCase().includes(needle));
	const sessions = (grids || []).flatMap((g) => (g.cards || []).filter((c) => !c.lost && `${c.name} ${c.branch || ""} ${c.path || ""} ${c.pr || ""} ${c.msg || ""} ${c.label || ""}`.toLocaleLowerCase().includes(needle)).map((c) => ({
		project: g.project,
		card: c
	})));
	const openProject = async (p) => {
		setOpenError(null);
		try {
			if (p.canPrompt === false) {
				const g = await fleet.grid(p.name);
				fleet.go(sessionRoute(p.name, g.cards?.find((c) => c.lead)?.name));
				return;
			}
			const r = await fleet.lead(p.name);
			fleet.go(sessionRoute(p.name, r.session || r.lead || "master"));
		} catch (e) {
			setOpenError(e);
		}
	};
	const first = () => projects.length ? openProject(projects[0]) : sessions.length ? fleet.go(sessionRoute(sessions[0].project.name, sessions[0].card.name)) : null;
	h(() => {
		field.current?.focus();
	}, []);
	useKeys((key) => {
		if (!key.ctrl && !key.alt && key.k === "/") {
			field.current?.focus();
			return true;
		}
		return false;
	});
	return /* @__PURE__ */ u(PhoneScreen, {
		title: t("phone.search"),
		error: openError || error || gridError || grids?.find((g) => g.error)?.error,
		loading,
		children: [
			/* @__PURE__ */ u(SearchInput, {
				value: q,
				onChange: setQ,
				onOpen: first,
				inputRef: field
			}),
			projects.length ? /* @__PURE__ */ u("section", { children: [/* @__PURE__ */ u("h2", { children: t("phone.projects") }), /* @__PURE__ */ u("div", {
				class: "extra-grid",
				children: projects.map((p) => /* @__PURE__ */ u("button", {
					class: "card extra-card",
					onClick: () => openProject(p),
					children: [/* @__PURE__ */ u("h3", { children: splitAddr(p.name)[0] }), /* @__PURE__ */ u("p", {
						class: "muted",
						children: p.host || p.path
					})]
				}, p.name))
			})] }) : null,
			needle && sessions.length ? /* @__PURE__ */ u("section", { children: [/* @__PURE__ */ u("h2", { children: t("phone.sessions") }), /* @__PURE__ */ u("div", {
				class: "extra-grid",
				children: sessions.map(({ project: p, card: c }) => /* @__PURE__ */ u("button", {
					class: "card extra-card",
					onClick: () => fleet.go(sessionRoute(p.name, c.name)),
					children: [
						/* @__PURE__ */ u(StatusPill, {
							status: c.status,
							small: true
						}),
						/* @__PURE__ */ u("h3", { children: c.name }),
						/* @__PURE__ */ u("p", { children: joinMeta(p.name, p.host) }),
						/* @__PURE__ */ u("p", {
							class: "muted",
							children: [
								c.branch,
								" ",
								c.pr,
								" ",
								c.label
							]
						}),
						/* @__PURE__ */ u("p", { children: c.msg })
					]
				}, `${p.name}/${c.name}`))
			})] }) : null,
			!loading && (!needle || !gridLoading) && !sessions.length && !projects.length ? /* @__PURE__ */ u("p", {
				class: "empty",
				children: t("phone.noMatches")
			}) : null
		]
	});
}
//#endregion
//#region web/ui/speakable.js
var EN = {
	code: "Code omitted.",
	timestamp: "a timestamp",
	id: "an id",
	hex: "a hex id",
	escape: "an escape code",
	commit: "a commit",
	link: "{label} link",
	theLink: "the link",
	line: "line",
	goesOn: "… and it goes on."
};
var SPEAK_MAX = 2e4;
var IDENT_EDGE = "(^|[^\\w./~@+-])";
function sayIdentifiers(t, w) {
	const pathSpoken = (p, line) => {
		const base = p.replace(/\/+$/, "").split("/").pop() || p;
		return line ? `${base} ${w.line} ${line.slice(1)}` : base;
	};
	t = t.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, w.timestamp);
	t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, w.id);
	t = t.replace(/\b0x[0-9a-f]+\b/gi, w.hex);
	t = t.replace(/\\(?:x[0-9a-f]{2}|u\{?[0-9a-f]{4,6}\}?|[0-7]{2,3})/gi, w.escape);
	t = t.replace(new RegExp(IDENT_EDGE + "((?:~|\\.{1,2})?\\/[\\w.@+~-]+(?:\\/[\\w.@+~-]+)*)(:\\d+)?(?::\\d+)?", "g"), (m, pre, p, line) => pre + pathSpoken(p, line));
	t = t.replace(new RegExp(IDENT_EDGE + "([\\w.@+~-]+(?:\\/[\\w.@+~-]+)*\\/[\\w.@+~-]*\\.\\w+)(:\\d+)?(?::\\d+)?", "g"), (m, pre, p, line) => pre + pathSpoken(p, line));
	t = t.replace(new RegExp(IDENT_EDGE + "([\\w.@+~-]*\\.\\w+):(\\d+)(?::\\d+)?", "g"), (m, pre, f, n) => `${pre}${f} ${w.line} ${n}`);
	t = t.replace(/* @__PURE__ */ new RegExp("(^|[^\\w.-])([0-9a-f]{7,40})(?![\\w.-])", "g"), (m, pre, h) => h.length >= 12 || /\d/.test(h) && /[a-f]/.test(h) ? pre + w.commit : m);
	t = t.replace(/ \/ /g, ", ");
	return t;
}
function speakable(text, w = EN) {
	let t = String(text || "");
	t = t.replace(/```[\s\S]*?```/g, `\n${w.code}\n`);
	t = t.replace(/`([^`]*)`/g, "$1");
	t = t.replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+.*$/gm, "");
	t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, (m, label) => w.link.replace("{label}", label));
	t = t.replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1");
	t = t.replace(/<https?:\/\/[^>\s]*>/g, ` ${w.theLink} `);
	t = t.replace(/https?:\/\/\S+/g, ` ${w.theLink} `);
	t = t.replace(/<\/?(?:br|p|div|span|b|i|em|strong|code|pre|kbd|sub|sup|details|summary|img|a|hr|ul|ol|li|table|tr|td|th)\b[^>]*>/gi, " ");
	t = t.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");
	t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
	t = t.replace(/~~[^~\n]+~~/g, "");
	t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
	t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (m, cells) => cells.split("|").map((c) => c.trim()).filter(Boolean).join(", "));
	t = t.replace(/[ \t]*[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]+/gu, "");
	t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
	t = t.replace(/^\s{0,3}[-*+]\s+/gm, "");
	t = t.replace(/^\[[ xX]\][ \t]+/gm, "");
	t = t.replace(/__([^_\n]+)__/g, "$1");
	t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\W)[*_]([^*_]+)[*_](\W|$)/g, "$1$2$3");
	t = sayIdentifiers(t, w);
	t = t.replace(/([^\s.!?…:;,])[ \t]*\n\s*/g, "$1. ");
	t = t.replace(/\s+/g, " ").trim();
	return t.length > SPEAK_MAX ? t.slice(0, SPEAK_MAX).replace(/\s\S*$/, "") + w.goesOn : t;
}
var CHUNK_ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Sr|Sra|approx|p\.ej)\.$/i;
function sentencesOf(t) {
	const out = [], re = /[.!?…]+["')\]]*(\s+|$)/g;
	let from = 0, m;
	while (m = re.exec(t)) {
		if (!m[0].length) {
			re.lastIndex++;
			continue;
		}
		const end = m.index + m[0].length;
		const piece = t.slice(from, m.index + m[0].length - m[1].length);
		if (CHUNK_ABBREV.test(piece) && end < t.length) continue;
		out.push(piece.trim());
		from = end;
	}
	if (from < t.length) out.push(t.slice(from).trim());
	return out.filter(Boolean);
}
function cutLong(x, max) {
	const out = [];
	while (x.length > max) {
		let at = -1;
		for (const mark of [/[,;:—–]\s/g, /\s/g]) {
			let m, best = -1;
			mark.lastIndex = 0;
			while ((m = mark.exec(x)) && m.index < max) best = m.index + m[0].length - 1;
			if (best >= max / 4) {
				at = best;
				break;
			}
		}
		if (at < 0) {
			const sp = x.indexOf(" ", max);
			if (sp < 0) break;
			at = sp;
		}
		out.push(x.slice(0, at).trim());
		x = x.slice(at).trim();
	}
	if (x) out.push(x);
	return out;
}
function speechChunks(text, max = 600) {
	const t = String(text || "").replace(/\s+/g, " ").trim();
	if (!t) return [];
	const out = [];
	let cur = "";
	for (const sen of sentencesOf(t)) for (const piece of sen.length > max ? cutLong(sen, max) : [sen]) {
		if (cur && cur.length + 1 + piece.length > max) {
			out.push(cur);
			cur = "";
		}
		cur = cur ? `${cur} ${piece}` : piece;
	}
	if (cur) out.push(cur);
	return out.filter((x) => /[\p{L}\p{N}]/u.test(x));
}
//#endregion
//#region web/ui/voice.js
var B = {};
function voiceBackend(adapter) {
	B = adapter || {};
	status = null;
}
var status = null;
async function voiceStatus(force = false) {
	if (status && !force) return status;
	try {
		status = B.voice ? await B.voice() : null;
	} catch {
		status = null;
	}
	status ||= {
		hear: { ready: false },
		speak: { ready: false }
	};
	return status;
}
function wav16k(chunks, rate) {
	let n = 0;
	for (const c of chunks) n += c.length;
	const all = new Float32Array(n);
	let o = 0;
	for (const c of chunks) {
		all.set(c, o);
		o += c.length;
	}
	const ratio = rate / 16e3, len = Math.floor(all.length / ratio);
	const buf = /* @__PURE__ */ new ArrayBuffer(44 + len * 2), v = new DataView(buf);
	const str = (off, s) => {
		for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
	};
	str(0, "RIFF");
	v.setUint32(4, 36 + len * 2, true);
	str(8, "WAVE");
	str(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, 16e3, true);
	v.setUint32(28, 32e3, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	str(36, "data");
	v.setUint32(40, len * 2, true);
	for (let i = 0; i < len; i++) {
		const a = Math.floor(i * ratio), b = Math.min(all.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		for (let j = a; j < b; j++) sum += all[j];
		const s = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
		v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
	}
	return new Blob([buf], { type: "audio/wav" });
}
var PAUSES = worded({
	normal: { ms: 2500 },
	larga: { ms: 4500 },
	manual: { ms: 0 }
}, "pause");
var AUDIO = {
	channelCount: 1,
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true
};
var transcribe = async (blob) => {
	if (!B.hear) throw new Error(t("voice.noHear"));
	const j = await B.hear(blob);
	return String(j?.text || "").trim();
};
var rmsOf = (d) => {
	let s = 0;
	for (let i = 0; i < d.length; i++) s += d[i] * d[i];
	return Math.sqrt(s / d.length);
};
var micDenied = () => t("voice.micDenied");
var VAD_DIR = "/vad-0.0.31/";
var vad = null;
var vadLoad = null;
var vadBroken = false;
var turn = null;
function warmVad() {
	if (vad || vadBroken) return Promise.resolve(vad);
	vadLoad ||= (B.vad ? B.vad() : Promise.reject(/* @__PURE__ */ new Error("this app ships no speech detector"))).then(({ MicVAD }) => MicVAD.new({
		model: "v5",
		baseAssetPath: VAD_DIR,
		onnxWASMBasePath: VAD_DIR,
		startOnLoad: false,
		ortConfig: (ort) => {
			ort.env.logLevel = "error";
			ort.env.wasm.numThreads = 1;
		},
		getStream: () => navigator.mediaDevices.getUserMedia({ audio: AUDIO }),
		resumeStream: () => navigator.mediaDevices.getUserMedia({ audio: AUDIO }),
		positiveSpeechThreshold: .5,
		negativeSpeechThreshold: .35,
		preSpeechPadMs: 600,
		minSpeechMs: 250,
		redemptionMs: PAUSES.normal.ms,
		submitUserSpeechOnPause: true,
		onFrameProcessed: (p, f) => turn?.frame(p, f),
		onSpeechStart: () => turn?.start(),
		onSpeechEnd: (a) => turn?.end(a),
		onVADMisfire: () => turn?.misfire()
	})).then((v) => vad = v, (e) => {
		vadBroken = true;
		console.warn("VAD did not load, using the loudness meter:", e);
		return null;
	}).finally(() => {
		vadLoad = null;
	});
	return vadLoad;
}
function listenLocal(opts) {
	let h = null, cancelled = false;
	const pending = {
		stop: () => {
			if (h) h.stop();
			else pending.stopAsked = true;
		},
		cancel: () => {
			cancelled = true;
			h?.cancel();
		}
	};
	warmVad().then((v) => {
		if (cancelled) return;
		h = v ? listenVad(v, opts) : listenLoudness(opts);
		if (pending.stopAsked) h.stop();
	});
	return pending;
}
function listenVad(v, { onLevel, onState, onSpeaking, onText, onError, pauseMs = PAUSES.normal.ms, maxMs = 18e4 }) {
	let done = false, spoke = false;
	const t0 = performance.now();
	const end = async (audio) => {
		if (done) return;
		done = true;
		turn = null;
		clearInterval(watch);
		try {
			await v.pause();
		} catch {}
		onSpeaking?.(false);
		if (!audio || audio.length < 4e3) {
			onText?.("");
			return;
		}
		onState?.("hearing");
		try {
			onText?.(await transcribe(wav16k([audio], 16e3)));
		} catch (e) {
			onError?.(t("voice.transcribeFailed", { why: e.message }));
			onText?.("");
		}
	};
	let got = null;
	const me = turn = {
		frame: (p, f) => {
			if (turn === me) onLevel?.(Math.min(1, rmsOf(f) * 12));
		},
		start: () => {
			spoke = true;
			onSpeaking?.(true);
		},
		misfire: () => onSpeaking?.(false),
		end: (audio) => {
			got = audio;
			if (pauseMs) end(audio);
		}
	};
	v.setOptions({ redemptionMs: pauseMs || 6e5 });
	const watch = setInterval(() => {
		const t = performance.now() - t0;
		if (!spoke && t > 15e3) cancel();
		else if (t > maxMs) stop();
	}, 500);
	const stop = async () => {
		if (done) return;
		if (turn === me) try {
			await v.pause();
		} catch {}
		end(got);
	};
	const cancel = () => {
		got = null;
		spoke = false;
		end(null);
	};
	v.start().then(() => {
		if (!done) onState?.("listening");
	}, () => {
		onError?.(micDenied());
		cancel();
	});
	return {
		stop,
		cancel
	};
}
function listenLoudness({ onLevel, onState, onSpeaking, onText, onError, pauseMs = PAUSES.normal.ms, maxMs = 18e4 }) {
	let stream, ctx, node, src, done = false, spoke = false, quietSince = 0;
	const chunks = [];
	const t0 = performance.now();
	const finish = async (send) => {
		if (done) return;
		done = true;
		try {
			node?.disconnect();
			src?.disconnect();
		} catch {}
		try {
			stream?.getTracks().forEach((x) => x.stop());
		} catch {}
		const rate = ctx?.sampleRate || 48e3;
		try {
			await ctx?.close();
		} catch {}
		onSpeaking?.(false);
		if (!send || !spoke || !chunks.length) {
			onText?.("");
			return;
		}
		onState?.("hearing");
		try {
			onText?.(await transcribe(wav16k(chunks, rate)));
		} catch (e) {
			onError?.(t("voice.transcribeFailed", { why: e.message }));
			onText?.("");
		}
	};
	(async () => {
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
		} catch {
			done = true;
			onError?.(micDenied());
			onText?.("");
			return;
		}
		ctx = new AudioContext();
		src = ctx.createMediaStreamSource(stream);
		node = ctx.createScriptProcessor(4096, 1, 1);
		let floor = .008;
		node.onaudioprocess = (e) => {
			if (done) return;
			const d = e.inputBuffer.getChannelData(0);
			chunks.push(new Float32Array(d));
			const rms = rmsOf(d);
			const now = performance.now();
			const loud = rms > Math.max(.015, floor * 2.5);
			if (!loud) floor = Math.min(.03, floor * .95 + rms * .05);
			onLevel?.(Math.min(1, rms * 12));
			if (loud) {
				if (!spoke) onSpeaking?.(true);
				spoke = true;
				quietSince = 0;
			} else if (spoke && !quietSince) quietSince = now;
			if (pauseMs && spoke && quietSince && now - quietSince > pauseMs) finish(true);
			else if (now - t0 > maxMs) finish(true);
			else if (!spoke && now - t0 > 15e3) finish(false);
		};
		src.connect(node);
		node.connect(ctx.destination);
		onState?.("listening");
	})();
	return {
		stop: () => finish(true),
		cancel: () => finish(false)
	};
}
var Recognition = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
var browserCanHear = !!Recognition;
var speechLang = () => lang() === "es" ? "es-ES" : "en-US";
function listenBrowser({ onInterim, onState, onText, onError, pauseMs = PAUSES.normal.ms, lang: speech = speechLang() }) {
	const r = new Recognition();
	r.lang = speech;
	r.interimResults = true;
	r.continuous = true;
	let final = "", quiet = null;
	const hush = () => {
		clearTimeout(quiet);
		if (pauseMs) quiet = setTimeout(() => {
			try {
				r.stop();
			} catch {}
		}, pauseMs);
	};
	r.onresult = (e) => {
		let live = "";
		for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) final += e.results[i][0].transcript;
		else live += e.results[i][0].transcript;
		onInterim?.((final + " " + live).trim());
		hush();
	};
	r.onerror = (e) => {
		if (e.error === "not-allowed") onError?.(t("voice.micDeniedShort"));
		else if (e.error === "network") onError?.(t("voice.needsNet"));
		else if (e.error !== "no-speech" && e.error !== "aborted") onError?.(t("voice.dictation", { why: e.error }));
	};
	r.onend = () => {
		clearTimeout(quiet);
		onText?.(final.trim());
	};
	try {
		r.start();
		onState?.("listening");
	} catch {
		onText?.("");
	}
	return {
		stop: () => {
			try {
				r.stop();
			} catch {}
		},
		cancel: () => {
			try {
				r.abort();
			} catch {}
		}
	};
}
var plainText = (md) => String(md || "").replace(/```[\s\S]*?```/g, ` ${t("voice.code")} `).replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_#>|]/g, " ").replace(/\s+/g, " ").trim();
var playing = null;
function stopSpeaking() {
	window.speechSynthesis?.cancel();
	if (playing) {
		playing.cancelled = true;
		try {
			playing.audio?.pause();
		} catch {}
		playing = null;
	}
}
function utter(text, onEnd) {
	const s = window.speechSynthesis;
	if (!s) {
		onEnd?.();
		return;
	}
	const u = new SpeechSynthesisUtterance(text);
	const all = s.getVoices();
	const v = lang() === "es" ? all.find((x) => /^es(-|_)(419|MX|US|EC|CO|AR)/i.test(x.lang)) || all.find((x) => /^es/i.test(x.lang)) : all.find((x) => /^en(-|_)(US|GB)/i.test(x.lang)) || all.find((x) => /^en/i.test(x.lang));
	if (v) u.voice = v;
	u.lang = v?.lang || speechLang();
	u.rate = 1.05;
	u.onend = () => onEnd?.();
	u.onerror = () => onEnd?.();
	s.speak(u);
}
async function speakBrowser(chunks, job) {
	for (const c of chunks) {
		if (job.cancelled) return;
		await new Promise((resolve) => utter(c, resolve));
	}
}
function playSample(url, onEnd) {
	stopSpeaking();
	const job = {
		cancelled: false,
		audio: new Audio(url)
	};
	playing = job;
	const done = () => {
		if (!job.cancelled) {
			playing = null;
			onEnd?.();
		}
	};
	job.audio.onended = done;
	job.audio.onerror = done;
	job.audio.play().catch(done);
}
var sayWords = () => Object.fromEntries(Object.keys(EN).map((k) => [k, t(`say.${k}`)]));
async function speak(md, onEnd, voice = "") {
	stopSpeaking();
	const chunks = speechChunks(speakable(md, sayWords()));
	if (!chunks.length) {
		onEnd?.();
		return;
	}
	const job = {
		cancelled: false,
		audio: null
	};
	playing = job;
	const st = await voiceStatus();
	if (job.cancelled) return;
	let i = 0;
	if (st.speak?.ready) try {
		let next = B.speak(chunks[0], voice);
		for (; i < chunks.length; i++) {
			const r = await next;
			if (job.cancelled) return;
			next = i + 1 < chunks.length ? B.speak(chunks[i + 1], voice) : null;
			next?.catch(() => {});
			for (const s of r.sentences) {
				if (job.cancelled) return;
				const url = await B.speakAudio(s.id);
				if (job.cancelled) return;
				await new Promise((resolve) => {
					const a = new Audio(url);
					job.audio = a;
					a.onended = resolve;
					a.onerror = resolve;
					a.play().catch(resolve);
				});
			}
		}
	} catch {}
	if (i < chunks.length) await speakBrowser(chunks.slice(i), job);
	if (!job.cancelled) {
		playing = null;
		onEnd?.();
	}
}
//#endregion
//#region web/ui/resolve.js
var norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
var phon = (s) => norm(s).replace(/qu/g, "k").replace(/q/g, "k").replace(/c([aou])/g, "k$1").replace(/c([ei])/g, "s$1").replace(/c\b/g, "k").replace(/ck/g, "k").replace(/z/g, "s").replace(/v/g, "b").replace(/w/g, "u").replace(/ll/g, "y").replace(/ph/g, "f").replace(/x/g, "ks").replace(/h/g, "").replace(/([a-z])\1+/g, "$1").replace(/\s+/g, " ").trim();
var grams = (s) => {
	const t = ` ${s} `;
	const g = /* @__PURE__ */ new Map();
	for (let i = 0; i < t.length - 1; i++) {
		const k = t.slice(i, i + 2);
		g.set(k, (g.get(k) || 0) + 1);
	}
	return g;
};
function dice(a, b) {
	const A = grams(a), B = grams(b);
	let both = 0, n = 0;
	for (const [k, v] of A) {
		n += v;
		both += Math.min(v, B.get(k) || 0);
	}
	for (const v of B.values()) n += v;
	return n ? 2 * both / n : 0;
}
var sim = (a, b) => phon(a) === phon(b) ? 1 : dice(phon(a), phon(b));
function bestName(name, options) {
	const n = norm(name);
	if (!n) return null;
	let hit = null, score = 0;
	for (const o of options) {
		const k = norm(o);
		const s = k === n ? 2 : (k.startsWith(n) || n.startsWith(k)) && Math.min(k.length, n.length) >= 3 ? 1.5 : sim(k, n);
		if (s > score) {
			hit = o;
			score = s;
		}
	}
	return score >= .6 ? hit : null;
}
function command(text, projects, context) {
	const t$5 = norm(text);
	if (!t$5) return null;
	const short = t$5.split(" ").length <= 9;
	if (short && (/^(muestrame |abre |ve a |ir a |vamos a |llevame a )?(el )?mapa( en vivo)?$/.test(t$5) || /^(show me |open |go to |take me to )?(the )?(live )?map$/.test(t$5))) return {
		go: "/map",
		say: t("cmd.map")
	};
	if (short && (/^(ve |vamos |llevame |volver |vuelve )?(al )?inicio$/.test(t$5) || /^(go |take me |back )?(to )?(the )?home( page)?$|^go home$/.test(t$5))) return {
		go: "/",
		say: t("cmd.home")
	};
	if (short && (/^(muestrame |abre |ve a )?(la )?actividad$/.test(t$5) || /^(show me |open |go to )?(the )?activity$/.test(t$5))) return {
		go: "/activity",
		say: t("cmd.activity")
	};
	const m = /^(?:abre|ve a|vamos a|llevame a|muestrame|ensename|cambia a|pasa a|anda a) (?:la )?sesion (.+)$/.exec(t$5) || /^(?:open|go to|take me to|show me|switch to) (?:the )?session (.+)$/.exec(t$5);
	if (m && short) {
		const all = (projects || []).flatMap((p) => p.sessions.map((x) => ({
			p: p.name,
			s: x.name
		})));
		const inCtx = all.filter((x) => x.p === context);
		const pick = (list) => {
			const k = bestName(m[1], list.map((x) => x.s));
			return k && list.find((x) => x.s === k);
		};
		const hit = pick(inCtx) || pick(all);
		if (hit) return {
			go: `/p/${encodeURIComponent(hit.p)}/s/${encodeURIComponent(hit.s)}`,
			project: hit.p,
			session: hit.s,
			say: hit.p !== context ? t("cmd.openIn", {
				session: hit.s,
				project: hit.p
			}) : t("cmd.open", { session: hit.s })
		};
		return {
			go: null,
			say: t("cmd.noSession", { name: m[1] })
		};
	}
	return null;
}
//#endregion
//#region web/ui/agent.js
var store = {
	get: (k, d) => {
		try {
			const v = localStorage.getItem(`gfw.${k}`);
			return v == null ? d : JSON.parse(v);
		} catch {
			return d;
		}
	},
	set: (k, v) => {
		try {
			localStorage.setItem(`gfw.${k}`, JSON.stringify(v));
		} catch {}
	}
};
var S = {
	pin: store.get("pin", ""),
	target: store.get("pin", "") || store.get("target", ""),
	targetAt: 0,
	feed: [],
	phase: "idle",
	level: 0,
	interim: "",
	cards: [],
	focus: "master",
	tasks: [],
	deciding: [],
	conversing: false,
	voiceOut: store.get("voiceOut", true),
	voice: store.get("voice", ""),
	handsFree: store.get("handsFree", false),
	follow: store.get("follow", true),
	pause: PAUSES[store.get("pause", "normal")] ? store.get("pause", "normal") : "normal",
	vs: null
};
var subs = /* @__PURE__ */ new Set();
function set(patch) {
	Object.assign(S, patch);
	for (const f of subs) f();
}
function useAgent() {
	const [, tick] = d(0);
	h(() => {
		const f = () => tick((x) => x + 1);
		subs.add(f);
		return () => subs.delete(f);
	}, []);
	return S;
}
var ctx = null;
var mic = null;
var gen = 0;
var timers = /* @__PURE__ */ new Set();
var later = (ms, fn) => {
	const t = setTimeout(() => {
		timers.delete(t);
		fn();
	}, ms);
	timers.add(t);
};
var push = (e) => set({ feed: [...S.feed.slice(-60), {
	id: Math.random(),
	at: Date.now(),
	...e
}] });
var projects = () => ctx?.projects || [];
var go = (to) => ctx?.go(to);
var api = new Proxy({}, { get: (_, k) => ctx?.fleet?.[k] || (() => Promise.reject(new Error(t("agent.noServer")))) });
var frame = (text, voice) => `${voice ? "[voice]" : "[typed]"} ${t(voice ? "agent.frame.voice" : "agent.frame.typed", {
	name: ctx?.me?.name || t("agent.you"),
	app: ctx?.app || "ghostfleet"
})} ${t("agent.frame.ask")}\n\n${text}`;
var FRAME_RE = /^(?:\[(?:voice|typed)\]|\u{1F399}\uFE0F?|\u{1F4AC})[^\n]*\n\n/u;
var unframe = (t) => String(t || "").replace(FRAME_RE, "");
function setOption(k, v) {
	store.set(k, v);
	set({ [k]: v });
	if (k === "handsFree" && !v) set({ conversing: false });
	if (k === "voiceOut" && !v) {
		stopSpeaking();
		if (S.phase === "speaking") set({ phase: "idle" });
	}
}
function setPin(project) {
	store.set("pin", project || "");
	set({ pin: project || "" });
	if (project) setTarget(project);
}
function setTarget(project, explicit = true) {
	if (!project) return;
	if (project !== S.target) {
		store.set("target", project);
		set({
			target: project,
			cards: [],
			focus: "master"
		});
		resetWatch();
	}
	if (explicit) set({ targetAt: Date.now() });
}
var canHear = () => !!S.vs?.hear?.ready || browserCanHear;
function talk() {
	if (mic) {
		mic.stop();
		return;
	}
	set({ conversing: S.handsFree });
	listen();
}
function listen() {
	if (mic) return;
	stopSpeaking();
	set({
		interim: "",
		level: 0,
		phase: "listening"
	});
	const my = gen;
	const common = {
		pauseMs: PAUSES[S.pause].ms,
		onState: (s) => {
			if (my === gen) set({ phase: s });
		},
		onError: (m) => {
			if (my !== gen) return;
			push({
				kind: "event",
				text: m,
				bad: true
			});
			set({ conversing: false });
		},
		onText: (t$1) => {
			if (my !== gen) return;
			mic = null;
			set({
				level: 0,
				interim: "",
				phase: "idle"
			});
			if (t$1) heard(t$1, true);
			else if (S.conversing) {
				set({ conversing: false });
				push({
					kind: "event",
					text: t("agent.heardNothing")
				});
			}
		}
	};
	mic = S.vs?.hear?.ready ? listenLocal({
		...common,
		onLevel: (l) => {
			if (my === gen) set({ level: l });
		}
	}) : listenBrowser({
		...common,
		onInterim: (t) => {
			if (my === gen) set({ interim: t });
		}
	});
}
var again = () => {
	const my = gen;
	if (S.conversing && S.handsFree) later(450, () => {
		if (my === gen && S.conversing) listen();
	});
};
function stop() {
	gen++;
	set({ conversing: false });
	for (const t of timers) clearTimeout(t);
	timers.clear();
	if (mic) {
		const m = mic;
		mic = null;
		m.cancel();
	}
	stopSpeaking();
	set({
		phase: "idle",
		interim: "",
		level: 0
	});
}
var busy = () => !!mic || S.phase === "speaking" || S.conversing;
function say(text, then) {
	if (!S.voiceOut) {
		then?.();
		return;
	}
	const my = gen;
	set({ phase: "speaking" });
	speak(text, () => {
		if (my !== gen) return;
		if (S.phase === "speaking") set({ phase: "idle" });
		then?.();
	}, S.voice);
}
var context = () => ctx?.route?.project || S.pin || (S.target && Date.now() - S.targetAt < 9e5 ? S.target : null);
function submit(text, voice = false) {
	const t = String(text || "").trim();
	if (t) heard(t, voice);
}
async function place(task, project) {
	try {
		const t$2 = await api.taskPlace(task.id, project);
		setTarget(project);
		const who = await deliver(t$2);
		say(who ? t("agent.passed", { who }) : t("task.missed", { project }), again);
	} catch (e) {
		push({
			kind: "event",
			text: t("agent.missed", { why: e.message }),
			bad: true
		});
	}
	pollTasks();
}
function tickOff(id) {
	set({ tasks: S.tasks.filter((t) => id ? t.id !== id : t.status !== "replied") });
	api.taskDone(id).catch(() => {});
}
var line = Promise.resolve();
var lastSaid = {
	text: "",
	at: 0
};
function heard(text, voice) {
	push({
		kind: "me",
		text,
		voice
	});
	const c = command(text, projects(), context());
	if (c) {
		if (c.go) go(c.go);
		if (c.project) setTarget(c.project, false);
		if (c.session) set({ focus: c.session });
		push({
			kind: "event",
			text: c.say
		});
		say(c.say, again);
		return;
	}
	if (text === lastSaid.text && Date.now() - lastSaid.at < 2e4) {
		push({
			kind: "event",
			text: t("agent.dupe")
		});
		return;
	}
	lastSaid = {
		text,
		at: Date.now()
	};
	const row = {
		id: Math.random(),
		text
	};
	set({ deciding: [...S.deciding, row] });
	line = line.then(() => decide(text, voice)).catch(() => {}).then(() => set({ deciding: S.deciding.filter((d) => d !== row) }));
}
var spokenName = (p) => String(p).replace(/[-_]+/g, " ");
var inWords = (l) => l.length < 2 ? l.join("") : `${l.slice(0, -1).join(", ")}${t("common.and")}${l[l.length - 1]}`;
async function decide(text, voice) {
	const my = gen;
	set({ phase: "routing" });
	const page = ctx?.route?.project ? {
		project: ctx.route.project,
		session: ctx.route.session || ""
	} : {
		project: S.pin,
		session: ""
	};
	const feed = S.feed.slice(0, -1).map(({ kind, text: t }) => ({
		kind,
		text: unframe(t)
	}));
	let r;
	try {
		r = await api.route({
			text,
			feed,
			page,
			voice
		});
	} catch (e) {
		set({ phase: "idle" });
		push({
			kind: "event",
			text: t("agent.routeFailed", {
				text,
				why: e.message
			}),
			bad: true
		});
		say(t("agent.routeFailedSay"), again);
		return;
	}
	if (my !== gen) {
		pollTasks();
		return;
	}
	set({ phase: "idle" });
	if (r.action === "ask") {
		push({
			kind: "event",
			text: r.question,
			ask: true
		});
		say(r.question, again);
		return;
	}
	if (r.action === "go") {
		setTarget(r.project);
		go(`/p/${encodeURIComponent(r.project)}${r.session ? `/s/${encodeURIComponent(r.session)}` : ""}`);
		const here = t("agent.here", { project: r.project });
		push({
			kind: "event",
			text: here
		});
		say(here, again);
		return;
	}
	const going = r.tasks.filter((t) => t.project), unsure = r.tasks.filter((t) => !t.project);
	await pollTasks();
	const reached = [], missed = [];
	for (const t of going) {
		if (going.length === 1) setTarget(t.project);
		const who = await deliver(t, going.length > 1);
		if (who) reached.push(going.length === 1 ? who : spokenName(t.project));
		else missed.push(spokenName(t.project));
	}
	for (const t of unsure) push({
		kind: "event",
		text: `“${t.title}”: ${t.question}`,
		ask: true
	});
	pollTasks();
	const words = [
		missed.length ? t("task.missed", { project: inWords(missed) }) : "",
		!voice || !reached.length ? "" : reached.length === 1 ? t("agent.passed", { who: reached[0] }) : t("agent.noted", {
			n: reached.length,
			list: inWords(reached)
		}),
		unsure.length === 1 ? unsure[0].question : unsure.length ? t("agent.unsure", { n: unsure.length }) : ""
	].filter(Boolean).join(" ");
	if (words) say(words, again);
	else again();
}
async function deliver(t$3, quiet = false) {
	const { project, session, text, voice, context: earlier, why } = t$3;
	const who = session ? t("agent.toSession", {
		session,
		project
	}) : t("agent.toLead", { project });
	if (!quiet && (!ctx?.route?.session || ctx.route.project !== project)) go(`/p/${encodeURIComponent(project)}`);
	push({
		kind: "event",
		text: why ? t("agent.goingWhy", {
			who,
			why
		}) : t("agent.going", { who })
	});
	set({
		phase: "starting",
		focus: session || "master"
	});
	const failed = (message) => {
		set({ phase: "idle" });
		push({
			kind: "event",
			text: message,
			bad: true
		});
		api.taskSent({
			id: t$3.id,
			project,
			error: message
		}).catch(() => {});
		return "";
	};
	let lead = session || "master";
	if (!session) try {
		const l = await api.lead(project);
		if (l.started) push({
			kind: "event",
			text: l.started === "start" ? t("agent.leadStarted", { project }) : t("agent.leadWoke", { project })
		});
		lead = l.lead || "master";
	} catch (e) {
		return failed(t("agent.leadFailed", {
			project,
			why: e.message
		}));
	}
	set({ phase: "sending" });
	try {
		sentAt = Math.floor(Date.now() / 1e3);
		const words = earlier ? `${t("agent.earlier", { earlier })}\n\n${text}` : text;
		const r = await api.act("fleet_send", {
			project,
			session: lead,
			prompt: frame(words, voice)
		});
		if (r.queued) push({
			kind: "event",
			text: r.queued === "question" ? t("agent.queuedQ") : t("agent.queuedTurn")
		});
		set({ phase: "idle" });
		await api.taskSent({
			id: t$3.id,
			project,
			session: lead
		});
		return who;
	} catch (e) {
		return failed(t("agent.missedAt", {
			project,
			why: e.message
		}));
	}
}
var heardUpTo = null;
var toRead = [];
var lastTs = (t) => t.replies.reduce((n, r) => Math.max(n, r.ts), 0);
async function pollTasks() {
	let tasks;
	try {
		({tasks} = await api.tasks());
	} catch {
		return;
	}
	set({ tasks });
	if (!heardUpTo) {
		heardUpTo = new Map(tasks.map((t) => [t.id, lastTs(t)]));
		return;
	}
	for (const t$4 of tasks) {
		const news = t$4.replies.filter((r) => r.ts > (heardUpTo.get(t$4.id) || 0));
		if (!news.length) continue;
		heardUpTo.set(t$4.id, lastTs(t$4));
		const sure = !t$4.hidden && tasks.filter((x) => !x.hidden && x.project === t$4.project && x.session === t$4.session).length === 1;
		for (const r of news) push({
			kind: "ai",
			text: r.text,
			project: t$4.project,
			session: t$4.session,
			title: sure ? t$4.title : ""
		});
		const from = sure ? t("agent.fromAbout", {
			project: spokenName(t$4.project),
			title: t$4.title
		}) : t("agent.from", { project: spokenName(t$4.project) });
		toRead = [...toRead.filter((x) => x.id !== t$4.id), {
			id: t$4.id,
			text: `${from} ${news[news.length - 1].text}`
		}];
	}
	readNext();
}
function readNext() {
	if (!toRead.length || mic || S.phase !== "idle" || document.hidden) return;
	const [next, ...rest] = toRead;
	toRead = rest;
	say(next.text, () => {
		again();
		readNext();
	});
}
var prev = null;
var sentAt = 0;
var lastGo = 0;
var loop = null;
var taskLoop = null;
function resetWatch() {
	prev = null;
}
async function tick() {
	if (!S.target || document.hidden) return;
	const project = S.target;
	let g;
	try {
		g = await api.grid(project);
	} catch {
		return;
	}
	if (project !== S.target) return;
	const list = g.cards || [];
	set({ cards: list });
	const before = prev;
	prev = Object.fromEntries(list.map((c) => [c.name, statusOf(c)]));
	if (before) for (const c of list) {
		const now = statusOf(c), was = before[c.name];
		if (was === now) continue;
		const word = (STATUS[now] || STATUS.unknown).label.toLowerCase();
		push({
			kind: "event",
			text: was == null ? t("agent.opened", { name: c.name }) : c.lead ? t("agent.leadIs", { word }) : `${c.name}: ${word}`,
			session: c.name,
			project
		});
		set({ focus: c.name });
		if (was == null && !c.lead && !c.owner && sentAt && Date.now() / 1e3 - sentAt < 900 && ctx?.fleet?.assign && ctx.me?.id) ctx.fleet.assign(project, c.name, ctx.me.id).catch(() => {});
		const worth = was == null || now === "need-you" || now === "working" && !c.lead;
		if (S.follow && worth && !c.lead && Date.now() - lastGo > 3e3) {
			lastGo = Date.now();
			go(`/p/${encodeURIComponent(project)}/s/${encodeURIComponent(c.name)}`);
		}
	}
}
function bind(next) {
	if (next.fleet !== ctx?.fleet) voiceBackend(next.fleet);
	ctx = next;
	if (!loop) {
		loop = setInterval(tick, 2500);
		taskLoop = setInterval(pollTasks, 3e3);
		pollTasks();
		resetWatch();
		voiceStatus(true).then((vs) => {
			set({ vs });
			if (vs.hear?.ready) warmVad();
		});
	}
}
function unbind() {
	stop();
	clearInterval(loop);
	clearInterval(taskLoop);
	loop = null;
	heardUpTo = null;
	toRead = [];
	ctx = null;
}
//#endregion
//#region web/ui/voices.jsx
var hello = () => t("vp.hello");
function VoicePicker() {
	const api = useFleet();
	const admin = !!(api.installVoice && api.deleteVoice);
	const S = useAgent();
	const [v, setV] = d(null);
	const [playing, setPlaying] = d("");
	const [bad, setBad] = d("");
	const [note, setNote] = d("");
	const load = () => api.voices().then(setV).catch((e) => setBad(e.message));
	h(() => {
		load();
		return () => stopSpeaking();
	}, []);
	const job = v?.job && !v.job.error ? v.job : null;
	h(() => {
		if (!job) return void 0;
		const timer = setTimeout(async () => {
			const n = await api.voices().catch(() => null);
			if (!n) return;
			setV(n);
			if (!n.job && n.voices.find((x) => x.key === job.key)?.installed) setOption("voice", `piper:${job.key}`);
		}, 1e3);
		return () => clearTimeout(timer);
	}, [v]);
	if (bad) return /* @__PURE__ */ u("p", {
		class: "vp-bad small",
		children: bad
	});
	if (!v) return /* @__PURE__ */ u("p", {
		class: "muted small",
		children: t("vp.loading")
	});
	const toggle = (id, start) => {
		if (playing === id) {
			stopSpeaking();
			setPlaying("");
			return;
		}
		setPlaying(id);
		start(() => setPlaying((p) => p === id ? "" : p));
	};
	const hear = (id) => toggle(id, (end) => speak(hello(), end, id));
	const sample = (x) => toggle(x.key, (end) => playSample(x.sample, end));
	const done = (r) => {
		setNote(r?.demo ? r.text : "");
		return load();
	};
	const download = (key) => api.installVoice(key).then(done).catch((e) => setBad(e.message));
	const erase = async (x) => {
		const demo = await api.deleteVoice(x.key).catch((e) => {
			setBad(e.message);
			return null;
		});
		if (demo?.demo) {
			setNote(demo.text);
			return;
		}
		if (S.voice === `piper:${x.key}`) setOption("voice", "");
		load();
	};
	const current = S.voice && [...v.kokoro.map((k) => k.id), ...v.voices.filter((x) => x.installed).map((x) => `piper:${x.key}`)].includes(S.voice) ? S.voice : v.kokoro.find((k) => k.default)?.id;
	const Pick = ({ id, children }) => /* @__PURE__ */ u("label", {
		class: "vp-pick",
		children: [/* @__PURE__ */ u("input", {
			type: "radio",
			name: "gfw-voice",
			checked: current === id,
			onChange: () => setOption("voice", id)
		}), /* @__PURE__ */ u("span", {
			class: "vp-name",
			children
		})]
	});
	const Listen = ({ id, onClick, label }) => /* @__PURE__ */ u(Btn, {
		kind: "sm",
		"aria-label": label,
		onClick,
		children: /* @__PURE__ */ u(Icon, { name: playing === id ? "stop" : "play" })
	});
	const local = v.voices.filter((x) => x.installed), online = v.voices.filter((x) => !x.installed);
	return /* @__PURE__ */ u("div", {
		class: "vp",
		children: [
			/* @__PURE__ */ u("div", {
				class: "vp-k small",
				children: t("vp.title")
			}),
			v.kokoro.map((k) => /* @__PURE__ */ u("div", {
				class: "vp-row",
				children: [/* @__PURE__ */ u(Pick, {
					id: k.id,
					children: [k.name, /* @__PURE__ */ u("small", { children: k.who })]
				}), /* @__PURE__ */ u(Listen, {
					id: k.id,
					label: t("vp.listen", { name: k.name }),
					onClick: () => hear(k.id)
				})]
			}, k.id)),
			local.map((x) => /* @__PURE__ */ u("div", {
				class: "vp-row",
				children: [
					/* @__PURE__ */ u(Pick, {
						id: `piper:${x.key}`,
						children: [x.name, /* @__PURE__ */ u("small", { children: x.place })]
					}),
					/* @__PURE__ */ u(Listen, {
						id: `piper:${x.key}`,
						label: t("vp.listen", { name: x.name }),
						onClick: () => hear(`piper:${x.key}`)
					}),
					admin ? /* @__PURE__ */ u(Btn, {
						kind: "sm",
						"aria-label": t("vp.delete", { name: x.name }),
						onClick: () => erase(x),
						children: "✕"
					}) : null
				]
			}, x.key)),
			online.length ? /* @__PURE__ */ u("div", {
				class: "vp-k small",
				children: t(admin ? "vp.online" : "vp.onlineView")
			}) : null,
			online.map((x) => /* @__PURE__ */ u("div", {
				class: "vp-row",
				children: [
					/* @__PURE__ */ u("span", {
						class: "vp-name grow",
						children: [x.name, /* @__PURE__ */ u("small", { children: [
							x.place,
							" · ",
							t("vp.quality", { q: x.quality }),
							" · ",
							x.mb,
							" MB"
						] })]
					}),
					/* @__PURE__ */ u(Listen, {
						id: x.key,
						label: t("vp.listen", { name: x.name }),
						onClick: () => sample(x)
					}),
					job?.key === x.key ? /* @__PURE__ */ u("span", {
						class: "muted small",
						children: job.step === "runtime" ? t("vp.preparing") : `${job.pct}%`
					}) : admin ? /* @__PURE__ */ u(Btn, {
						kind: "sm",
						disabled: !!job,
						onClick: () => download(x.key),
						children: t("vp.download")
					}) : null
				]
			}, x.key)),
			note ? /* @__PURE__ */ u("p", {
				class: "vp-note muted small",
				role: "status",
				children: note
			}) : null,
			v.job?.error ? /* @__PURE__ */ u("p", {
				class: "vp-bad small",
				children: t("vp.failed", {
					name: v.job.name,
					why: v.job.error
				})
			}) : null
		]
	});
}
//#endregion
//#region web/ui/assistant.jsx
var STATE_WORDS = words([
	"listening",
	"hearing",
	"routing",
	"sending",
	"starting",
	"thinking",
	"acting",
	"speaking",
	"idle",
	"off"
], "ship");
var LIVE = [
	"listening",
	"hearing",
	"routing",
	"sending",
	"starting",
	"speaking"
];
var stateWord = (S, state) => `${STATE_WORDS[state]}${state === "acting" && S.focus ? ` ${t("as.in", { where: S.focus })}` : ""}`;
var working = (state) => !["idle", "off"].includes(state);
function shipStateOf(S) {
	if (LIVE.includes(S.phase)) return S.phase;
	const master = S.cards.find((c) => c.lead);
	if (!master) return "off";
	const st = statusOf(master);
	if (st === "working") return S.focus !== master.name ? "acting" : "thinking";
	return st === "need-you" ? "thinking" : "idle";
}
function rankedProjects(projects) {
	const last = (p) => Math.max(0, ...p.sessions.map((s) => s.ts || 0));
	return [...projects || []].sort((a, b) => b.counts.need_you - a.counts.need_you || last(b) - last(a) || a.name.localeCompare(b.name));
}
function TalkTo({ projects, compact }) {
	const S = useAgent();
	const list = T(() => rankedProjects(projects), [projects]);
	const has = (name) => list.some((p) => p.name === name);
	const options = [
		{
			value: "",
			label: t("as.auto")
		},
		...projects == null && S.pin ? [{
			value: S.pin,
			label: t("as.leadOf", { project: S.pin })
		}] : [],
		...list.map((p) => ({
			value: p.name,
			label: t(p.sessions.some((s) => s.lead) ? "as.leadOf" : "as.leadLater", { project: p.name })
		}))
	];
	return /* @__PURE__ */ u(Select, {
		field: compact ? "talk-to small" : "field as-target",
		label: t("as.talkingTo"),
		value: projects == null || has(S.pin) ? S.pin : "",
		onChange: setPin,
		options
	});
}
function Console({ projects, big, foot }) {
	const S = useAgent();
	const [typed, setTyped] = d("");
	const listening = S.phase === "listening" || S.phase === "hearing";
	const active = busy() || listening || LIVE.includes(S.phase);
	const local = !!S.vs?.hear?.ready;
	return /* @__PURE__ */ u("div", {
		class: `console${big ? " big" : ""}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "console-row",
				children: [/* @__PURE__ */ u("button", {
					class: `mic${listening ? " on" : ""}`,
					disabled: !canHear() || S.phase === "hearing",
					onClick: talk,
					"aria-label": listening ? t("as.doneTalking") : t("as.talk"),
					children: [
						/* @__PURE__ */ u("span", {
							class: "mic-ico",
							children: S.phase === "hearing" ? "…" : /* @__PURE__ */ u(Icon, { name: listening ? "check" : "mic" })
						}),
						/* @__PURE__ */ u("span", { children: S.phase === "hearing" ? t("ship.hearing") : listening ? S.pause === "manual" ? t("as.listenManual") : t("as.listenAuto") : t("as.talk") }),
						S.phase === "listening" && local ? /* @__PURE__ */ u("span", {
							class: "meter",
							children: /* @__PURE__ */ u("i", { style: { width: `${Math.round(S.level * 100)}%` } })
						}) : null
					]
				}), active ? /* @__PURE__ */ u("button", {
					class: "stop-all",
					onClick: stop,
					"aria-label": t("as.stopAll"),
					children: [
						/* @__PURE__ */ u(Icon, { name: "stop" }),
						" ",
						t("sess.stop")
					]
				}) : null]
			}),
			/* @__PURE__ */ u("form", {
				class: "row",
				onSubmit: (e) => {
					e.preventDefault();
					const said = typed;
					setTyped("");
					submit(said, false);
				},
				children: [/* @__PURE__ */ u("input", {
					class: "grow",
					value: typed,
					onInput: (e) => setTyped(e.currentTarget.value),
					placeholder: big ? t("as.typeBig") : t("as.type")
				}), /* @__PURE__ */ u(Btn, {
					kind: "primary",
					type: "submit",
					disabled: !typed.trim(),
					children: t("common.send")
				})]
			}),
			foot ? /* @__PURE__ */ u("div", {
				class: "console-foot",
				children: [foot, voiceOpts(S, local)]
			}) : voiceOpts(S, local)
		]
	});
}
function voiceOpts(S, local) {
	return /* @__PURE__ */ u(Popover, {
		class: "voice-opts-btn",
		boxClass: "voice-opts",
		icon: "gear",
		label: t("as.voiceOpts"),
		title: t("as.voiceOpts"),
		children: [
			/* @__PURE__ */ u("p", {
				class: "voice-src muted small",
				children: S.vs == null ? t("as.vsChecking") : local ? /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u(Icon, { name: "lock" }),
					" ",
					t("as.vsLocal")
				] }) : browserCanHear ? t("as.vsBrowser") : t("as.vsNone")
			}),
			S.phase === "listening" ? /* @__PURE__ */ u("p", {
				class: "listen-hint small",
				children: S.pause === "manual" ? t("as.hintManual") : t("as.hintAuto", { s: S.pause === "larga" ? t("as.sLong") : t("as.sShort") })
			}) : null,
			/* @__PURE__ */ u(Select, {
				field: "pause-pick small",
				label: t("as.whenPause"),
				value: S.pause,
				options: Object.entries(PAUSES).map(([k, p]) => ({
					value: k,
					label: p.label
				})),
				onChange: (v) => setOption("pause", v)
			}),
			/* @__PURE__ */ u("div", {
				class: "toggles",
				children: [
					/* @__PURE__ */ u("label", { children: [
						/* @__PURE__ */ u("input", {
							type: "checkbox",
							checked: S.voiceOut,
							onChange: (e) => setOption("voiceOut", e.currentTarget.checked)
						}),
						" ",
						t("as.voiceOut")
					] }),
					/* @__PURE__ */ u("label", { children: [
						/* @__PURE__ */ u("input", {
							type: "checkbox",
							checked: S.handsFree,
							onChange: (e) => setOption("handsFree", e.currentTarget.checked)
						}),
						" ",
						t("as.handsFree")
					] }),
					/* @__PURE__ */ u("label", { children: [
						/* @__PURE__ */ u("input", {
							type: "checkbox",
							checked: S.follow,
							onChange: (e) => setOption("follow", e.currentTarget.checked)
						}),
						" ",
						t("as.follow")
					] })
				]
			})
		]
	});
}
function Feed({ limit, empty }) {
	const S = useAgent();
	const ref = A(null);
	const rows = limit ? S.feed.slice(-limit) : S.feed;
	h(() => {
		const n = ref.current;
		if (n) n.scrollTop = n.scrollHeight;
	}, [S.feed.length, S.interim]);
	return /* @__PURE__ */ u("div", {
		class: "as-feed",
		ref,
		children: [
			!rows.length && !S.interim ? empty : null,
			rows.map((e) => /* @__PURE__ */ u("div", {
				class: `as-row ${e.kind}${e.bad ? " bad" : ""}${e.ask ? " ask-row" : ""}${e.session && e.project ? " go" : ""}`,
				onClick: e.session && e.project ? () => go$1(`/p/${encodeURIComponent(e.project)}/s/${encodeURIComponent(e.session)}`) : void 0,
				children: e.kind === "me" ? /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u("span", {
						class: "tag-me",
						children: e.voice ? /* @__PURE__ */ u(S$1, { children: [
							/* @__PURE__ */ u(Icon, { name: "mic" }),
							" ",
							t("settings.you")
						] }) : t("settings.you")
					}),
					" ",
					unframe(e.text)
				] }) : e.kind === "ai" ? /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u("span", {
						class: "tag-ai",
						children: e.project || t("common.lead")
					}),
					e.title ? /* @__PURE__ */ u("em", {
						class: "tag-about",
						children: [" ", e.title]
					}) : null,
					" ",
					plainText(e.text)
				] }) : /* @__PURE__ */ u(S$1, { children: [
					/* @__PURE__ */ u("span", {
						class: "tag-ev",
						children: e.ask ? t("as.question") : t("as.live")
					}),
					" ",
					e.text
				] })
			}, e.id)),
			S.interim ? /* @__PURE__ */ u("div", {
				class: "as-row me live",
				children: [
					/* @__PURE__ */ u("span", {
						class: "tag-me",
						children: /* @__PURE__ */ u(Icon, { name: "mic" })
					}),
					" ",
					S.interim,
					"…"
				]
			}) : null
		]
	});
}
function Sea({}) {
	const S = useAgent();
	const state = shipStateOf(S);
	const lane = [...S.cards].sort((a, b) => Number(b.lead) - Number(a.lead));
	const at = Math.max(0, lane.findIndex((c) => c.name === S.focus));
	return /* @__PURE__ */ u("div", {
		class: `sea st-${state}`,
		children: [/* @__PURE__ */ u("div", {
			class: "ship-track",
			style: {
				"--i": at,
				"--n": Math.max(lane.length, 1)
			},
			children: [/* @__PURE__ */ u(GhostShip, {
				size: 64,
				state
			}), /* @__PURE__ */ u("span", {
				class: "ship-say",
				children: stateWord(S, state)
			})]
		}), /* @__PURE__ */ u("div", {
			class: "lane",
			style: { "--n": Math.max(lane.length, 1) },
			children: [!lane.length ? /* @__PURE__ */ u("span", {
				class: "muted small lane-empty",
				children: t("as.laneEmpty")
			}) : null, lane.map((c) => {
				const s = statusOf(c);
				return /* @__PURE__ */ u("button", {
					class: `buoy c-${(STATUS[s] || STATUS.unknown).color}${c.name === S.focus ? " on" : ""}`,
					title: `${c.label || c.name} · ${(STATUS[s] || STATUS.unknown).label}`,
					onClick: () => go$1(`/p/${encodeURIComponent(S.target)}/s/${encodeURIComponent(c.name)}`),
					children: [/* @__PURE__ */ u("b", { children: /* @__PURE__ */ u(StatusMark, { status: s }) }), /* @__PURE__ */ u("span", { children: c.lead ? t("common.lead") : c.name })]
				}, c.name);
			})]
		})]
	});
}
var Hint = () => /* @__PURE__ */ u("div", {
	class: "as-hint",
	children: [
		/* @__PURE__ */ u("p", { children: /* @__PURE__ */ u("b", { children: t("as.hint.title") }) }),
		/* @__PURE__ */ u("p", {
			class: "muted",
			children: t("as.hint.examples")
		}),
		/* @__PURE__ */ u("p", {
			class: "muted",
			children: t("as.hint.how")
		})
	]
});
function Assistant({ projects, onClose, chip }) {
	const [choosing, setChoosing] = d(false);
	const voices = !!useFleet().voices;
	return /* @__PURE__ */ u("aside", {
		class: "assistant",
		"aria-label": t("as.name"),
		children: [
			/* @__PURE__ */ u("header", {
				class: "as-head",
				children: [/* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("b", { children: t("as.name") }), /* @__PURE__ */ u("small", { children: t("as.sub") })] }), /* @__PURE__ */ u("span", {
					class: "as-head-end",
					children: [
						chip,
						voices ? /* @__PURE__ */ u(Btn, {
							kind: "sm",
							"aria-expanded": choosing,
							onClick: () => setChoosing(!choosing),
							children: choosing ? t("common.back") : t("as.pickVoice")
						}) : null,
						/* @__PURE__ */ u("button", {
							class: "x",
							"aria-label": t("as.close"),
							onClick: onClose,
							children: "✕"
						})
					]
				})]
			}),
			/* @__PURE__ */ u(TalkTo, { projects }),
			/* @__PURE__ */ u(Proposals, {}),
			choosing && voices ? /* @__PURE__ */ u("div", {
				class: "as-voices",
				children: /* @__PURE__ */ u(VoicePicker, {})
			}) : /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Sea, {}), /* @__PURE__ */ u(Feed, { empty: /* @__PURE__ */ u(Hint, {}) })] }),
			/* @__PURE__ */ u("div", {
				class: "as-controls",
				children: /* @__PURE__ */ u(Console, { projects })
			})
		]
	});
}
function Proposals() {
	const fleet = useFleet();
	const has = typeof fleet.proposals === "function";
	const { data, reload } = usePoll(() => has ? fleet.proposals() : Promise.resolve([]), has ? 15e3 : 0, [has]);
	const [busyId, setBusyId] = d("");
	const list = Array.isArray(data) ? data : [];
	if (!has || !list.length) return null;
	const answer = async (p, yes) => {
		setBusyId(p.id);
		try {
			await fleet.answerProposal(p, yes);
			toast(t(yes ? "as.proposalYesDone" : "as.proposalNoDone", { summary: p.summary }), "good");
		} catch (e) {
			toast(String(e && e.message || e), "bad");
		} finally {
			setBusyId("");
			reload();
		}
	};
	return /* @__PURE__ */ u("ul", {
		class: "as-asks",
		"aria-label": t("as.proposals"),
		children: list.map((p) => /* @__PURE__ */ u("li", {
			class: "as-ask",
			children: [/* @__PURE__ */ u("span", {
				class: "grow",
				children: [
					t(p.granted ? "as.proposalGranted" : "as.proposal", { summary: p.summary }),
					" ",
					/* @__PURE__ */ u("small", {
						class: "muted",
						children: p.id
					})
				]
			}), p.granted ? null : /* @__PURE__ */ u("span", {
				class: "as-ask-btns",
				children: [/* @__PURE__ */ u(Btn, {
					kind: "primary sm",
					disabled: busyId === p.id,
					onClick: () => answer(p, true),
					children: t("as.proposalYes")
				}), /* @__PURE__ */ u(Btn, {
					kind: "sm",
					disabled: busyId === p.id,
					onClick: () => answer(p, false),
					children: t("as.proposalNo")
				})]
			})]
		}, p.id))
	});
}
function HomeAgent({ projects }) {
	const S = useAgent();
	const state = shipStateOf(S);
	return /* @__PURE__ */ u("section", {
		class: "home-agent",
		children: [
			/* @__PURE__ */ u("div", {
				class: "home-agent-head",
				children: [/* @__PURE__ */ u(GhostShip, {
					size: 64,
					state
				}), /* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("h2", { children: t("as.today") }), /* @__PURE__ */ u("p", {
					class: "home-say",
					"aria-live": "polite",
					children: working(state) ? stateWord(S, state) : ""
				})] })]
			}),
			/* @__PURE__ */ u(Proposals, {}),
			/* @__PURE__ */ u(Console, {
				projects,
				big: true,
				foot: /* @__PURE__ */ u(TalkTo, {
					projects,
					compact: true
				})
			}),
			S.feed.length || S.interim ? /* @__PURE__ */ u(Feed, { limit: 8 }) : null
		]
	});
}
function Launcher({ onOpen }) {
	const S = useAgent();
	const state = shipStateOf(S);
	const live = LIVE.includes(S.phase) || S.conversing;
	const doing = working(state);
	const word = doing ? stateWord(S, state) : S.conversing ? `${t("as.name")} · ${t("as.conversing")}` : t("as.name");
	return /* @__PURE__ */ u("div", {
		class: `as-dock st-${state}`,
		children: [
			S.phase === "listening" && S.vs?.hear?.ready ? /* @__PURE__ */ u("span", {
				class: "vb-meter",
				children: /* @__PURE__ */ u("i", { style: { width: `${Math.round(S.level * 100)}%` } })
			}) : null,
			S.phase === "listening" ? /* @__PURE__ */ u("button", {
				class: "vb-btn",
				onClick: talk,
				children: [
					/* @__PURE__ */ u(Icon, { name: "check" }),
					" ",
					t("as.done")
				]
			}) : null,
			live ? /* @__PURE__ */ u("button", {
				class: "vb-stop",
				onClick: stop,
				children: [
					/* @__PURE__ */ u(Icon, { name: "stop" }),
					" ",
					t("sess.stop")
				]
			}) : null,
			/* @__PURE__ */ u("button", {
				class: `as-launch${doing || live ? " busy" : ""}`,
				onClick: onOpen,
				title: t("as.open"),
				"aria-label": doing || S.conversing ? `${t("as.open")} · ${word}` : t("as.open"),
				children: [
					/* @__PURE__ */ u(GhostShip, {
						size: 32,
						state: doing ? state : "idle"
					}),
					" ",
					/* @__PURE__ */ u("span", {
						class: "as-say",
						"aria-live": "polite",
						children: word
					})
				]
			})
		]
	});
}
//#endregion
//#region web/ui/accounts.jsx
var POLL_MS = 45e3;
var FLOOR_MS = 1e4;
var TICK_MS = 5e3;
var RED = /* @__PURE__ */ new Set([
	"out",
	"exhausted",
	"needs-login",
	"blocked"
]);
var workers = (x) => t(`acct.workers.${[
	"paused",
	"running",
	"mixed"
].includes(x && x.workers) ? x.workers : "paused"}`);
var until = (at) => at ? t("acct.until", { at }) : "";
var hue = (a) => RED.has(a.kind) ? "red" : a.kind === "stale" ? "yellow" : a.active ? a.stale ? "yellow" : "green" : "grey";
function win(w, label, short = false) {
	if (!w) return `${label} —`;
	return short ? `${label} ${w.pct}% (${label === "5h" ? w.left : w.day})` : t("acct.resets", {
		label,
		pct: w.pct,
		at: w.resets_at,
		read: w.read
	});
}
function usageLines(u) {
	if (!u) return [];
	if (!u.enabled) return [{
		profile: "",
		text: u.off || t("acct.off"),
		color: "grey"
	}];
	const ps = u.profiles || [];
	if (!ps.length) return [{
		profile: "",
		text: t("acct.none"),
		color: "grey"
	}];
	return ps.map((p) => {
		const profile = ps.length > 1 ? p.profile : "";
		if (p.exhausted) return {
			profile,
			text: t("acct.exhausted", {
				until: until(p.exhausted.until_at),
				workers: workers(p.exhausted)
			}),
			color: "red"
		};
		if (p.unsaved) return {
			profile,
			text: t("acct.unsaved"),
			color: "yellow"
		};
		const a = (p.accounts || []).find((x) => x.active);
		if (!a) return {
			profile,
			text: t("acct.noActive"),
			color: "grey"
		};
		if (a.kind !== "active") return {
			profile,
			text: `${a.name} · ${a.state}`,
			color: hue(a)
		};
		const read = a.stale ? ` · ${t("acct.read", { when: (a.seven_day || a.five_hour || {}).read || t("acct.never") })}` : "";
		return {
			profile,
			text: `${a.name} · ${win(a.five_hour, "5h", true)} · ${win(a.seven_day, "7d", true)}${read}`,
			color: hue(a)
		};
	});
}
function useUsage(fleet) {
	const [u, setU] = d(null);
	h(() => {
		if (!fleet.usage) return void 0;
		let live = true, busy = false, wanted = false, at = 0;
		const read = () => {
			busy = true;
			wanted = false;
			Promise.resolve().then(() => fleet.usage()).then((j) => {
				if (live) setU(j);
			}, () => {}).finally(() => {
				busy = false;
				at = Date.now();
			});
		};
		const tick = () => {
			if (busy || document.hidden) return;
			const since = Date.now() - at;
			if (since >= POLL_MS || wanted && since >= FLOOR_MS) read();
		};
		const soon = () => {
			wanted = true;
		};
		const shown = () => {
			if (!document.hidden) soon();
		};
		read();
		const iv = setInterval(tick, TICK_MS);
		addEventListener("focus", soon);
		document.addEventListener("visibilitychange", shown);
		return () => {
			live = false;
			clearInterval(iv);
			removeEventListener("focus", soon);
			document.removeEventListener("visibilitychange", shown);
		};
	}, [fleet]);
	return u;
}
function AccountsLine() {
	const u$1 = useUsage(useFleet());
	const [open, setOpen] = d(false);
	const lines = usageLines(u$1);
	if (!lines.length) return null;
	const kids = lines.map((l, i) => /* @__PURE__ */ u("div", {
		class: `u-line u-${l.color}`,
		children: [l.profile ? /* @__PURE__ */ u("span", {
			class: "u-prof",
			children: l.profile
		}) : null, /* @__PURE__ */ u("span", {
			class: "u-text",
			children: l.text
		})]
	}, i));
	if (!u$1.enabled) return /* @__PURE__ */ u("div", {
		class: "usage",
		children: kids
	});
	return /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("button", {
		type: "button",
		class: "usage",
		"aria-haspopup": "dialog",
		title: t("acct.open"),
		onClick: () => setOpen(true),
		children: kids
	}), open ? /* @__PURE__ */ u(AccountsDialog, {
		u: u$1,
		onClose: () => setOpen(false)
	}) : null] });
}
function AccountsDialog({ u: u$2, onClose }) {
	const ps = u$2.profiles || [];
	return /* @__PURE__ */ u(Modal, {
		title: t("acct.title"),
		onClose,
		children: /* @__PURE__ */ u("div", {
			class: "modal-body usage-list",
			children: [
				/* @__PURE__ */ u("p", { children: t("acct.threshold", { pct: u$2.threshold }) }),
				!ps.length ? /* @__PURE__ */ u("p", { children: t("acct.noProfile") }) : null,
				ps.map((p) => /* @__PURE__ */ u("section", { children: [/* @__PURE__ */ u("h3", {
					class: "u-prof",
					children: [p.profile, p.unsaved ? t("acct.profUnsaved") : p.exhausted ? t("acct.profExhausted", {
						until: until(p.exhausted.until_at),
						workers: workers(p.exhausted)
					}) : ""]
				}), !(p.accounts || []).length ? /* @__PURE__ */ u("p", { children: t("acct.noAccounts") }) : /* @__PURE__ */ u(S$1, { children: [
					p.accounts.length < 2 ? /* @__PURE__ */ u("p", { children: t("acct.one") }) : null,
					p.pin ? /* @__PURE__ */ u("p", {
						class: "u-pin",
						children: t("acct.pin", {
							account: p.pin.account,
							at: p.pin.until_at
						})
					}) : null,
					p.accounts.map((a) => /* @__PURE__ */ u("div", {
						class: `u-acct u-${hue(a)}`,
						children: [
							/* @__PURE__ */ u("div", {
								class: "u-head",
								children: [/* @__PURE__ */ u("span", {
									class: "u-name",
									children: [a.active ? "* " : "", a.name]
								}), /* @__PURE__ */ u("span", {
									class: "u-state",
									children: [a.state, a.active && a.state !== "active" ? t("acct.activeTag") : ""]
								})]
							}),
							/* @__PURE__ */ u("div", {
								class: "u-win",
								children: win(a.five_hour, "5h")
							}),
							/* @__PURE__ */ u("div", {
								class: "u-win",
								children: win(a.seven_day, "7d")
							}),
							a.fix ? /* @__PURE__ */ u("p", {
								class: "u-fix",
								children: a.fix
							}) : null
						]
					}, a.name))
				] })] }, p.profile)),
				/* @__PURE__ */ u("p", {
					class: "muted",
					children: t("acct.readOnly")
				})
			]
		})
	});
}
//#endregion
//#region web/ui/tasks.jsx
var STATES$1 = worded({
	ask: {
		color: "yellow",
		rank: 0
	},
	failed: {
		color: "red",
		rank: 0
	},
	"need-you": {
		color: "red",
		rank: 1
	},
	replied: {
		color: "green",
		rank: 2
	},
	working: {
		color: "cyan",
		rank: 3
	},
	sent: {
		color: "grey",
		rank: 4
	},
	sending: {
		color: "grey",
		rank: 4
	}
}, "task.state");
var shown = (S) => S.tasks.filter((x) => !x.hidden).sort((a, b) => STATES$1[a.status].rank - STATES$1[b.status].rank || a.at - b.at);
var hhmm = (ts) => (/* @__PURE__ */ new Date(ts * 1e3)).toLocaleTimeString(locale(), {
	hour: "2-digit",
	minute: "2-digit"
});
function Places({ task, projects }) {
	const [all, setAll] = d(false);
	const names = (projects || []).map((p) => p.name).sort((a, b) => a.localeCompare(b));
	const list = all || !task.options.length ? names : task.options;
	return /* @__PURE__ */ u("div", {
		class: "tk-places",
		children: [list.map((n) => /* @__PURE__ */ u("button", {
			class: "pchip",
			onClick: () => place(task, n),
			children: n
		}, n)), task.options.length && !all ? /* @__PURE__ */ u("button", {
			class: "pchip more",
			onClick: () => setAll(true),
			children: t("task.other")
		}) : null]
	});
}
function Task({ task, projects }) {
	const [open, setOpen] = d(false);
	const st = STATES$1[task.status];
	const last = task.replies[task.replies.length - 1];
	const where = task.session || t("common.lead");
	const waiting = task.status === "ask" || task.status === "failed";
	const goTo = () => go$1(`/p/${encodeURIComponent(task.project)}${task.session ? `/s/${encodeURIComponent(task.session)}` : ""}`);
	return /* @__PURE__ */ u("li", {
		class: `tk c-${st.color}`,
		children: [
			/* @__PURE__ */ u("div", {
				class: "tk-top",
				children: [
					/* @__PURE__ */ u("span", {
						class: "tk-state",
						children: st.label
					}),
					/* @__PURE__ */ u("small", {
						class: "tk-time",
						children: hhmm(task.at)
					}),
					/* @__PURE__ */ u("button", {
						class: "tk-ok",
						"aria-label": t("task.tickAria", { title: task.title }),
						title: t("task.tick"),
						onClick: () => tickOff(task.id),
						children: "✓"
					})
				]
			}),
			/* @__PURE__ */ u("button", {
				class: "tk-title",
				"aria-expanded": open,
				onClick: () => setOpen((o) => !o),
				children: task.title
			}),
			task.project ? /* @__PURE__ */ u("button", {
				class: "tk-place",
				onClick: goTo,
				children: [
					task.project,
					" · ",
					where
				]
			}) : null,
			waiting ? /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u("p", {
				class: "tk-q",
				children: task.error || task.question
			}), /* @__PURE__ */ u(Places, {
				task,
				projects
			})] }) : null,
			last && !open ? /* @__PURE__ */ u("p", {
				class: "tk-reply",
				children: plainText(last.text).slice(0, 110)
			}) : null,
			open ? /* @__PURE__ */ u("div", {
				class: "tk-more",
				children: [/* @__PURE__ */ u("p", {
					class: "tk-said",
					children: [
						"“",
						task.text,
						"”"
					]
				}), task.replies.map((r) => /* @__PURE__ */ u("p", {
					class: "tk-reply full",
					children: plainText(r.text)
				}, r.ts))]
			}) : null
		]
	});
}
function TaskRail({ projects, onClose }) {
	const S = useAgent();
	const list = shown(S);
	const replied = list.filter((x) => x.status === "replied").length;
	return /* @__PURE__ */ u("aside", {
		class: "rail",
		"aria-label": t("task.title"),
		children: [/* @__PURE__ */ u("header", {
			class: "rail-head",
			children: [
				/* @__PURE__ */ u("b", { children: t("task.title") }),
				/* @__PURE__ */ u("span", {
					class: "n",
					children: list.length
				}),
				/* @__PURE__ */ u("span", { class: "grow" }),
				replied > 1 ? /* @__PURE__ */ u("button", {
					class: "rail-clear",
					onClick: () => tickOff(""),
					children: t("task.clear")
				}) : null,
				/* @__PURE__ */ u("button", {
					class: "x",
					"aria-label": t("task.hide"),
					onClick: onClose,
					children: "✕"
				})
			]
		}), /* @__PURE__ */ u("ul", {
			class: "tk-list",
			children: [list.map((x) => /* @__PURE__ */ u(Task, {
				task: x,
				projects
			}, x.id)), S.deciding.map((d) => /* @__PURE__ */ u("li", {
				class: "tk c-grey deciding",
				children: [/* @__PURE__ */ u("span", {
					class: "tk-state",
					children: t("task.deciding")
				}), /* @__PURE__ */ u("p", {
					class: "tk-said",
					children: [
						"“",
						d.text,
						"”"
					]
				})]
			}, d.id))]
		})]
	});
}
function TaskChip({ onClick, floating }) {
	const S = useAgent();
	const list = shown(S);
	const waiting = list.filter((x) => STATES$1[x.status].rank < 2).length;
	return /* @__PURE__ */ u("button", {
		class: `tk-chip${floating ? " floating" : ""}`,
		onClick,
		"aria-label": t("task.see", { n: list.length }),
		children: [
			t("task.title"),
			" ",
			list.length + S.deciding.length,
			waiting ? /* @__PURE__ */ u("span", {
				class: "badge bad",
				children: waiting
			}) : null
		]
	});
}
//#endregion
//#region web/ui/app.jsx
var VIEWS = [
	{ view: "home" },
	{ view: "map" },
	{ view: "project" },
	{
		view: "automations",
		nav: ["bolt", "phone.nav.automations"]
	},
	{
		view: "reviews",
		nav: ["check", "phone.reviews"]
	},
	{
		view: "stack-picker",
		nav: ["branch", "phone.stackPlace"]
	},
	{
		view: "stack",
		under: "stack-picker"
	},
	{
		view: "queue",
		nav: ["hourglass", "phone.queue"]
	},
	{
		view: "held",
		under: "queue"
	},
	{
		view: "sign-ins",
		nav: ["key", "phone.signIns"]
	},
	{
		view: "search",
		nav: ["search", "phone.search"]
	},
	{
		view: "activity",
		nav: ["list", "nav.activity"]
	},
	{ view: "settings" }
];
var SHARED = VIEWS.map((v) => v.view);
var decode = (x) => {
	try {
		return decodeURIComponent(x);
	} catch {
		return x;
	}
};
function parseRoute(hash, extra) {
	const shared = sharedRoute(hash);
	if (shared && shared.view !== "home") return shared;
	const [path, query = ""] = String(hash).split("?");
	const parts = path.replace(/^#\/?/, "").split("/").map(decode);
	const v = VIEWS.find((x) => x.view === parts[0] && ![
		"home",
		"map",
		"project"
	].includes(x.view));
	if (v) {
		let q = "";
		try {
			q = new URLSearchParams(query).get("q") || "";
		} catch {}
		return {
			view: v.view,
			id: parts[1] || null,
			rest: parts.slice(1).filter(Boolean),
			q
		};
	}
	return parts[0] && extra?.parse?.(parts) || { view: "home" };
}
function NotHere({ view }) {
	return /* @__PURE__ */ u("div", {
		class: "page narrow",
		children: [/* @__PURE__ */ u("header", {
			class: "page-head",
			children: /* @__PURE__ */ u("div", { children: /* @__PURE__ */ u("h1", { children: t(VIEWS.find((v) => v.view === view)?.nav?.[1] || "nav.home") }) })
		}), /* @__PURE__ */ u("p", {
			class: "muted",
			children: t("app.notHere")
		})]
	});
}
function stackMembers(id) {
	let v;
	try {
		v = JSON.parse(id || "[]");
	} catch {
		return [];
	}
	return Array.isArray(v) ? v.filter((m) => m && typeof m.project === "string" && typeof m.session === "string").map((m) => ({
		project: m.project,
		session: m.session
	})) : [];
}
var SCREENS = {
	map: (r, p) => /* @__PURE__ */ u(FleetMap, { projects: p.projects }),
	project: (r) => /* @__PURE__ */ u(ProjectView, {
		project: r.project,
		session: r.session,
		tool: r.tool
	}, r.project),
	automations: (r, p) => /* @__PURE__ */ u(Automations, {
		projects: p.projects,
		id: r.id
	}, r.id || "list"),
	reviews: (r) => r.rest.length >= 3 ? /* @__PURE__ */ u(Review, {
		host: r.rest[0] === "-" ? "" : r.rest[0],
		profile: r.rest[1],
		run: r.rest[2]
	}, r.rest.join("/")) : /* @__PURE__ */ u(Reviews, {}),
	"stack-picker": () => /* @__PURE__ */ u(StackPicker, {}),
	stack: (r) => /* @__PURE__ */ u(StackView, { members: stackMembers(r.id) }, r.id),
	queue: () => /* @__PURE__ */ u(Queue, {}),
	held: (r) => /* @__PURE__ */ u(Held, {
		project: r.rest[0] || null,
		id: r.rest[1] || null
	}),
	"sign-ins": () => /* @__PURE__ */ u(SignIns, {}),
	search: (r) => /* @__PURE__ */ u(Search, { query: r.q }),
	activity: () => /* @__PURE__ */ u(Activity, {}),
	settings: () => /* @__PURE__ */ u(Settings, {})
};
var kept = (k, d) => {
	try {
		const v = localStorage.getItem(k);
		return v == null ? d : v === "1";
	} catch {
		return d;
	}
};
var keep = (k, on) => {
	try {
		localStorage.setItem(k, on ? "1" : "0");
	} catch {}
};
function FleetApp({ name, sub, projects, hosts, me, extra, frame = {}, badges = {}, canonical }) {
	const fleet = useFleet();
	const route = useHashRoute((h) => parseRoute(h, extra), canonical);
	const [asOpen, setAsOpen] = d(() => kept("gfw.asOpen", false));
	const [railOpen, setRailOpen] = d(() => kept("gfw.rail", typeof innerWidth === "number" && innerWidth > 900));
	h(() => keep("gfw.rail", railOpen), [railOpen]);
	h(() => keep("gfw.asOpen", asOpen), [asOpen]);
	const S = useAgent();
	const asked = S.tasks.some((x) => !x.hidden) || S.deciding.length > 0;
	const rail = asked && railOpen;
	const home = route.view === "home";
	const panel = asOpen && !home;
	h(() => {
		if (home) setAsOpen(false);
	}, [home]);
	bind({
		go: go$1,
		me,
		projects: projects || [],
		route,
		fleet,
		app: name
	});
	h(() => () => unbind(), []);
	const offers = (view) => fleet.offers ? fleet.offers(view) : true;
	const own = extra?.screens?.[route.view];
	let main;
	if (own) main = own(route);
	else if (home) main = /* @__PURE__ */ u(Home, {
		projects,
		children: [/* @__PURE__ */ u(AccountsLine, {}), /* @__PURE__ */ u(HomeAgent, { projects })]
	});
	else if (SHARED.includes(route.view) && !offers(route.view)) main = /* @__PURE__ */ u(NotHere, { view: route.view });
	else main = SCREENS[route.view](route, { projects });
	return /* @__PURE__ */ u(Frame, {
		name,
		sub,
		route,
		projects,
		hosts,
		settings: "/settings",
		class: `${frame.class || ""}${panel ? " with-as" : ""}${rail ? " with-rail" : ""}`,
		nav: (close) => /* @__PURE__ */ u(S$1, { children: [VIEWS.filter((v) => v.nav && offers(v.view)).map((v) => /* @__PURE__ */ u(NavLink, {
			to: `/${v.view}`,
			active: route.view === v.view || VIEWS.find((x) => x.view === route.view)?.under === v.view,
			onClick: close,
			children: [
				/* @__PURE__ */ u(Icon, { name: v.nav[0] }),
				" ",
				t(v.nav[1]),
				" ",
				badges[v.view] ? /* @__PURE__ */ u("span", {
					class: "badge warn",
					children: badges[v.view]
				}) : null
			]
		}, v.view)), extra?.nav ? extra.nav(route, close) : null] }),
		below: frame.below,
		foot: frame.foot || ((close) => /* @__PURE__ */ u("div", {
			class: "side-foot",
			children: [/* @__PURE__ */ u("span", { class: "grow" }), /* @__PURE__ */ u("a", {
				href: "#/settings",
				class: "icon-btn",
				title: t("nav.settings"),
				"aria-label": t("nav.settings"),
				onClick: close,
				children: /* @__PURE__ */ u(Icon, { name: "gear" })
			})]
		})),
		topEnd: frame.topEnd,
		banner: frame.banner,
		after: /* @__PURE__ */ u(S$1, { children: [rail ? /* @__PURE__ */ u(TaskRail, {
			projects,
			onClose: () => setRailOpen(false)
		}) : null, panel ? /* @__PURE__ */ u(Assistant, {
			route,
			projects,
			onClose: () => setAsOpen(false),
			chip: asked && !rail ? /* @__PURE__ */ u(TaskChip, { onClick: () => setRailOpen(true) }) : null
		}) : /* @__PURE__ */ u(S$1, { children: [asked && !rail ? /* @__PURE__ */ u(TaskChip, {
			floating: true,
			onClick: () => setRailOpen(true)
		}) : null, home ? null : /* @__PURE__ */ u(Launcher, { onOpen: () => setAsOpen(true) })] })] }),
		children: main
	});
}
//#endregion
//#region web/src/tasks.js
var KEY = "gf.tasks";
var FOLLOW_S = 259200;
var STUCK_S = 180;
var now = () => Math.floor(Date.now() / 1e3);
var id = () => Math.random().toString(16).slice(2, 14);
function load() {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) || "[]");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}
function save(all) {
	const done = all.filter((t) => t.done);
	const keep = [...all.filter((t) => !t.done), ...done.slice(-50)];
	try {
		localStorage.setItem(KEY, JSON.stringify(keep));
	} catch {}
}
var title = (text) => {
	const s = String(text || "").replace(/\s+/g, " ").trim();
	return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};
function createTasks(fleet, tr) {
	const open = () => load().filter((t) => !t.done);
	function add(d) {
		const all = load();
		const t = {
			id: id(),
			at: now(),
			from: now(),
			title: title(d.text),
			text: d.text,
			voice: !!d.voice,
			project: d.project || "",
			session: d.session || "",
			context: "",
			why: d.why || "",
			question: d.question || "",
			options: d.options || [],
			status: d.project ? "sending" : "ask",
			hidden: false,
			replies: [],
			live: ""
		};
		all.push(t);
		save(all);
		return t;
	}
	async function route({ text, page, voice }) {
		const names = await fleet.projects();
		if (page?.project && names.includes(page.project)) return {
			action: "tasks",
			tasks: [add({
				text,
				voice,
				project: page.project,
				session: page.session || "",
				why: tr("task.why.page")
			})]
		};
		const jarvis = await fleet.jarvis().catch(() => null);
		if (jarvis && names.includes(jarvis)) return {
			action: "tasks",
			tasks: [add({
				text,
				voice,
				project: jarvis,
				why: tr("task.why.jarvis")
			})]
		};
		if (names.length === 1) return {
			action: "tasks",
			tasks: [add({
				text,
				voice,
				project: names[0],
				why: tr("task.why.only")
			})]
		};
		if (!names.length) return {
			action: "ask",
			tasks: [],
			question: tr("task.noProjects")
		};
		return {
			action: "tasks",
			tasks: [add({
				text,
				voice,
				question: tr("task.which"),
				options: names
			})]
		};
	}
	function edit(tid, fn) {
		const all = load();
		const t = all.find((x) => x.id === tid && !x.done);
		if (!t) return null;
		fn(t);
		save(all);
		return t;
	}
	const place = async (tid, project) => {
		const t = edit(tid, (x) => Object.assign(x, {
			project,
			session: "",
			status: "sending",
			question: "",
			options: [],
			error: "",
			from: now()
		}));
		if (!t) throw new Error(tr("task.gone"));
		return t;
	};
	const sent = async ({ id: tid, project, session, error }) => {
		edit(tid, (x) => error ? Object.assign(x, {
			status: "failed",
			error: String(error).slice(0, 300),
			question: tr("task.missed", { project }),
			options: [project]
		}) : Object.assign(x, {
			status: x.status === "sending" ? "sent" : x.status,
			lead: session
		}));
		return { ok: true };
	};
	const done = async (tid) => {
		const all = load();
		for (const t of all) if (!t.done && (tid ? t.id === tid : t.status === "replied")) t.done = true;
		save(all);
		return { ok: true };
	};
	const lastRead = /* @__PURE__ */ new Map();
	async function watch() {
		const all = load();
		let changed = false;
		for (const t of all) if (!t.done && t.status === "sending" && now() - t.from > STUCK_S) {
			Object.assign(t, {
				status: "failed",
				error: tr("task.unsent"),
				question: "",
				options: [t.project]
			});
			changed = true;
		}
		const followed = all.filter((t) => !t.done && t.project && [
			"sent",
			"working",
			"need-you",
			"replied"
		].includes(t.status) && now() - t.from < FOLLOW_S);
		const groups = /* @__PURE__ */ new Map();
		for (const t of followed) {
			const key = `${t.project}\x1f${t.session || t.lead || "master"}`;
			groups.set(key, [...groups.get(key) || [], t]);
		}
		for (const [key, list] of groups) {
			if (Date.now() - (lastRead.get(key) || 0) < 1e4) continue;
			lastRead.set(key, Date.now());
			const [project, name] = key.split("");
			let messages = [], live = "";
			try {
				messages = (await fleet.session(project, name)).messages || [];
			} catch {
				continue;
			}
			try {
				live = ((await fleet.grid(project)).cards || []).find((c) => c.name === name)?.status || "";
			} catch {}
			for (const m of messages) {
				if (m.role !== "assistant" || !m.text) continue;
				const t = [...list].sort((a, b) => a.from - b.from).filter((x) => x.from <= m.ts).pop();
				if (!t || t.replies.some((r) => r.ts >= m.ts)) continue;
				t.replies = [...t.replies, {
					ts: m.ts,
					text: String(m.text).slice(0, 4e3)
				}].slice(-6);
				changed = true;
			}
			const newest = list.reduce((a, b) => b.from >= a.from ? b : a);
			for (const t of list) {
				const status = t === newest && ["working", "need-you"].includes(live) ? live : t.replies.length ? "replied" : "sent";
				if (status !== t.status || t.live !== live) {
					t.status = status;
					t.live = live;
					changed = true;
				}
			}
		}
		if (changed) save(all);
	}
	let watching = null;
	const tasks = async () => {
		if (!watching) watching = watch().catch(() => {}).finally(() => {
			watching = null;
		});
		await watching;
		return { tasks: open() };
	};
	return {
		route,
		tasks,
		taskSent: sent,
		taskPlace: place,
		taskDone: done
	};
}
var SCREEN_PLACES = Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.entries({
	"/automations": "phone.nav.automations",
	"/reviews": "phone.reviews",
	"/stack-picker": "phone.stackPlace",
	"/stack": "phone.stackPlace",
	"/queue": "phone.queue",
	"/held": "phone.held",
	"/search": "phone.search",
	"/sign-ins": "phone.signIns"
}).map(([route, key]) => [route, {
	enumerable: true,
	get: () => t(key)
}]))));
function screenPlace(route) {
	const root = "/" + String(route || "").replace(/^#?\/?/, "").split(/[/?#]/)[0];
	return Object.hasOwn(SCREEN_PLACES, root) ? SCREEN_PLACES[root] : null;
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
var own = (o, k) => typeof k === "string" && Object.hasOwn(o, k);
var needsPasskey = (a) => (a?.steps || []).some((s) => own(ACTIONS, s.action) && ACTIONS[s.action].passkey);
//#endregion
//#region web/src/adapter-extras.js
async function assertion(purpose) {
	if (!passkey.available() || !passkey.registered()) {
		if (passkey.bypassAllowed()) return null;
		throw new Error("Register a passkey before continuing");
	}
	return passkey.fresh(purpose);
}
var toPhone = (value) => JSON.parse(JSON.stringify(value).replace(/\{proyecto\}/g, "{project}").replace(/\{sesion\}/g, "{session}").replace(/\{fecha\}/g, "{date}").replace(/\{hora\}/g, "{time}"));
var toShared = (value) => JSON.parse(JSON.stringify(value).replace(/\{project\}/g, "{proyecto}").replace(/\{session\}/g, "{sesion}").replace(/\{date\}/g, "{fecha}").replace(/\{time\}/g, "{hora}"));
var automations = [];
var adapterExtras = {
	hasPeople: false,
	screenProjects: api$1.getProjects,
	waiting: api$1.getWaiting,
	reviews: api$1.getShots,
	review: api$1.getShotsRun,
	saveReview: api$1.postShotsVerdict,
	pendingSignIns: api$1.getLogins,
	startAccountLogin: api$1.startAccountLogin,
	async finishLogin(project, id, callback) {
		try {
			return { ok: (await api$1.finishLogin(project, id, callback, await assertion("finish login"))).ok === true };
		} finally {
			callback = "";
		}
	},
	async finishAccountLogin(project, id, code) {
		try {
			return { ok: (await api$1.finishAccountLogin(project, id, code, await assertion("finish login"))).ok === true };
		} finally {
			code = "";
		}
	},
	async automations() {
		const j = await api$1.getAutomations();
		automations = j.automations || [];
		return {
			...j,
			automations: automations.map((a) => ({
				...toShared(a),
				scope: "personal",
				mine: true,
				editable: true
			})),
			capabilities: {
				scopes: ["personal"],
				actions: Object.keys(ACTIONS),
				events: Object.keys(EVENTS),
				states: STATES
			}
		};
	},
	async saveAutomation(value) {
		const a = toPhone(value);
		return api$1.saveAutomation(a, needsPasskey(a) ? await assertion("save automation") : null);
	},
	deleteAutomation: api$1.deleteAutomation,
	async runAutomation(id) {
		const a = automations.find((a) => a.id === id);
		return api$1.runAutomation(id, a && needsPasskey(a) ? await assertion("run automation") : null);
	},
	async automationAI(messages, draft) {
		const r = await api$1.automationDraft(messages, draft ? toPhone(draft) : null);
		return {
			...r,
			automation: r.automation ? toShared(r.automation) : null
		};
	},
	automationsSeen: api$1.automationsSeen
};
//#endregion
//#region web/src/lead.js
function makeLead({ grid, projects, act, remote, wait, noLead, tries = 20, every = 1500 }) {
	return async function lead(project) {
		const find = async () => ((await grid(project)).cards || []).find((c) => c.lead);
		const m = await find();
		let did = null;
		if (!m) {
			const p = ((await projects()).projects || []).find((x) => x.name === project);
			if (!p || remote(project)) throw noLead(project);
			did = "start";
			await act("fleet_project_add", {
				path: p.path,
				name: p.name,
				profile: p.profile,
				start: true
			});
		} else if (m.lost || m.exited) {
			did = "reopen";
			await act("fleet_reopen", {
				project,
				session: m.name
			});
		} else if (m.asleep) {
			did = "wake";
			await act("fleet_wake", {
				project,
				session: m.name
			});
		} else if (m.status === "parked") {
			did = "resume";
			await act("fleet_resume", {
				project,
				session: m.name
			});
		}
		if (!did) return {
			ok: true,
			started: null,
			lead: m.name
		};
		for (let i = 0; i < tries; i++) {
			await wait(every);
			const n = await find().catch(() => null);
			if (n && !n.lost && !n.asleep && !["starting", "unknown"].includes(n.status)) return {
				ok: true,
				started: did,
				lead: n.name
			};
		}
		return {
			ok: true,
			started: did,
			lead: m ? m.name : "master"
		};
	};
}
//#endregion
//#region web/src/adapter.js
var PASSKEY = /* @__PURE__ */ new Set([
	"fleet_spawn",
	"fleet_stop",
	"fleet_rename",
	"fleet_worktree_remove",
	"fleet_project_add"
]);
var NOT_SERVED = /* @__PURE__ */ new Set([
	"gfw_label",
	"gfw_schedule",
	"gfw_unschedule"
]);
var devKind = () => /Mac/.test(passkey.device().noun) ? "mac" : "phone";
var remote = (project) => /@[^@]+$/.test(String(project || ""));
function assertFor(purpose) {
	if (!passkey.available() || !passkey.registered()) {
		if (passkey.bypassAllowed()) return Promise.resolve(null);
		return Promise.reject(new Error(t("lock.noPasskey", { why: passkey.unavailableReason() || t("lock.enrolHint") })));
	}
	return passkey.freshReady() ? passkey.freshNow(purpose) : passkey.fresh(purpose);
}
var fromCards = (cards) => {
	const at = Math.floor(Date.now() / 1e3);
	return (cards || []).map((c) => ({
		name: c.name,
		status: c.status,
		ts: at - (Number(c.age) || 0),
		lead: !!c.lead
	}));
};
function counted(sessions) {
	const counts = {
		need_you: 0,
		working: 0,
		ready: 0,
		parked: 0,
		lost: 0,
		total: 0
	};
	for (const s of sessions) {
		counts.total++;
		if (s.status === "need-you") counts.need_you++;
		else if (s.status in counts) counts[s.status]++;
	}
	return counts;
}
function phoneAdapter({ lock, go, place }) {
	const guard = (p) => p.catch((e) => {
		if (e instanceof api$1.AuthError) lock();
		throw e;
	});
	const off = /* @__PURE__ */ new Set();
	const noted = (view) => (e) => {
		if (e?.status === 404) off.add(view);
		throw e;
	};
	api$1.getAutomations().catch(noted("automations")).catch(() => {});
	let termOn = null, termAsked = false, termReading = null;
	const readTerm = () => {
		termAsked = true;
		return termReading ||= api$1.getTerm().then((j) => {
			termOn = !!j.enabled;
		}, () => {}).finally(() => {
			termReading = null;
		});
	};
	const termOff = () => Object.assign(new Error(t("term.off")), {
		status: 403,
		needs: "enable"
	});
	const openTerm = (project, kind, size) => {
		const asking = passkey.available() && passkey.registered() ? passkey.freshNow(`${kind === "edit" ? "editor" : "terminal"} ${project}`) : Promise.resolve(null);
		return guard(asking.then((a) => api$1.termOpen(project, size, a, kind))).catch((e) => {
			if (e && e.needs === "enable") termOn = false;
			throw e;
		});
	};
	const peerGrids = /* @__PURE__ */ new Map();
	async function peerSessions(name) {
		const hit = peerGrids.get(name);
		if (hit && Date.now() - hit.at < 15e3) return hit.sessions;
		let sessions = hit ? hit.sessions : [];
		try {
			sessions = fromCards((await api$1.getGrid(name)).cards);
		} catch {}
		peerGrids.set(name, {
			at: Date.now(),
			sessions
		});
		return sessions;
	}
	async function projects() {
		const j = await guard(api$1.getProjects());
		const digest = await api$1.getDigest().catch(() => null);
		const local = new Map((digest?.projects || []).map((p) => [p.name, p]));
		return {
			projects: await Promise.all((j.projects || []).map(async (p) => {
				const d = !p.host_key && local.get(p.name);
				const sessions = d ? (d.sessions || []).map((s) => ({
					name: s.name,
					status: s.status,
					ts: s.ts,
					lead: !!s.lead
				})) : p.host_key ? await peerSessions(p.name) : fromCards((await api$1.getGrid(p.name).catch(() => ({ cards: [] }))).cards);
				return {
					name: p.name,
					path: p.path,
					profile: p.profile,
					agent: p.agent || null,
					model: p.model || null,
					host: p.host || "",
					host_key: p.host_key || "",
					sched: p.sched || null,
					counts: counted(sessions),
					sessions
				};
			})),
			hosts: j.hosts || []
		};
	}
	let jarvisAt = 0, jarvis = null, jarvisOff = false;
	const noteJarvis = (j) => {
		jarvisAt = Date.now();
		jarvis = j && j.present !== false && j.project ? j.project : null;
		return j;
	};
	async function jarvisProject() {
		if (jarvisOff || Date.now() - jarvisAt < 6e4) return jarvis;
		jarvisAt = Date.now();
		try {
			noteJarvis(await api$1.getJarvis());
		} catch (e) {
			jarvis = null;
			if (e?.status === 404) jarvisOff = true;
		}
		return jarvis;
	}
	async function act(tool, args = {}, opts = {}) {
		if (NOT_SERVED.has(tool)) throw new Error(t("phone.notServed"));
		const assertion = PASSKEY.has(tool) ? await assertFor(`${tool} ${args.session || args.name || args.path || ""}`.trim()) : null;
		return guard(api$1.verb(tool, args, assertion));
	}
	const lead = makeLead({
		grid: (project) => guard(api$1.getGrid(project)),
		projects: () => api$1.getProjects(),
		act,
		remote,
		wait: (ms) => new Promise((r) => setTimeout(r, ms)),
		noLead: (project) => new Error(t("phone.noLead", { project }))
	});
	const tasks = createTasks({
		projects: async () => ((await api$1.getProjects()).projects || []).map((p) => p.name),
		jarvis: jarvisProject,
		session: (project, name) => api$1.getSession(project, name),
		grid: (project) => api$1.getGrid(project)
	}, t);
	const urls = [];
	async function speakAudio(id) {
		const buf = await guard(api$1.speakAudio(id));
		const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
		urls.push(url);
		while (urls.length > 8) try {
			URL.revokeObjectURL(urls.shift());
		} catch {}
		return url;
	}
	const server = () => api$1.mode() === "server";
	return {
		...Object.fromEntries(Object.entries(adapterExtras).map(([k, v]) => [k, typeof v === "function" ? (...a) => guard(Promise.resolve().then(() => v(...a)).catch(k === "automations" ? noted("automations") : (e) => {
			throw e;
		})) : v])),
		projects,
		grid: (project) => guard(api$1.getGrid(project)),
		session: async (project, name, before, opts) => {
			const r = await guard(api$1.getSession(project, name, before, opts || {}));
			return r && r.notModified ? r : {
				...r,
				queued: r.queue || r.queued || []
			};
		},
		heldFor: api$1.heldFor,
		usage: () => guard(api$1.getUsage()),
		pane: (project, name) => guard(api$1.getPane(project, name)),
		act,
		attach: (project, session, file) => guard(api$1.attach(project, session, file)),
		attachPerMessage: api$1.ATTACH_PER_MESSAGE,
		lead,
		canTerm: (project) => {
			if (server() && !termAsked) readTerm();
			return server() && !remote(project);
		},
		termWhy: (project) => remote(project) ? t("phone.noTermRemote", { host: String(project).split("@").pop() }) : "",
		proposals: async () => {
			if (jarvisOff) return [];
			try {
				const j = noteJarvis(await guard(api$1.getJarvis()));
				return j && j.present !== false && j.pending || [];
			} catch (e) {
				if (e?.status === 404) {
					jarvisOff = true;
					return [];
				}
				throw e;
			}
		},
		answerProposal: async (p, yes) => guard(api$1.jarvisConfirm(p.id, yes ? "yes" : "no", yes ? await assertFor(`jarvis yes ${p.id}`) : null)),
		termOpen: (project, kind, size) => {
			if (termReading) return termReading.then(() => termOn === false ? Promise.reject(termOff()) : openTerm(project, kind, size));
			if (termOn === false) {
				readTerm();
				return Promise.reject(termOff());
			}
			return openTerm(project, kind, size);
		},
		termSocket: api$1.termSocket,
		go,
		place: (to) => screenPlace(to) || place?.(to) || null,
		offers: (view) => !off.has(view),
		can: (verb) => !NOT_SERVED.has(verb),
		activity: async () => {
			return { rows: ((await guard(api$1.getAudit(100))).rows || []).filter((r) => !r.unparseable).reverse().map((r) => ({
				...r,
				by: r.client || "",
				result: r.result === "ran" ? "ran" : r.result === "refused" ? "refused" : r.result
			})) };
		},
		...tasks,
		voice: async () => {
			const j = await api$1.getVoice();
			return {
				hear: {
					ready: server() && !!j.voice?.ready,
					why: j.voice?.why || null
				},
				speak: {
					ready: server() && !!j.speak?.ready,
					why: j.speak?.why || null
				}
			};
		},
		hear: (wav) => guard(api$1.hear(wav)),
		speak: async (text) => ({ sentences: await guard(api$1.speakPlan(text)) }),
		speakAudio,
		settings: {
			push: {
				state: () => state(t),
				set: (on) => on ? enable(t) : disable()
			},
			terminal: {
				state: async () => {
					if (!server()) return {
						ready: false,
						why: t("phone.termFixtures")
					};
					try {
						termOn = !!(await guard(api$1.getTerm())).enabled;
						return {
							ready: true,
							on: termOn,
							why: termOn ? t("phone.termOn") : ""
						};
					} catch (e) {
						return {
							ready: false,
							why: e.status === 404 ? t("phone.termOld") : e.message
						};
					}
				},
				set: async (on) => {
					const a = on && passkey.registered() ? await passkey.fresh("terminal on") : null;
					await guard(api$1.termEnable(on, a));
					termOn = !!on;
				}
			},
			hosts: {
				list: async () => (await guard(api$1.getProjects())).hosts || [],
				unpair: (key) => guard(api$1.unpairHost(key))
			},
			device: {
				state: () => {
					const k = devKind();
					if (!passkey.available()) return {
						text: t("phone.noSensor"),
						detail: passkey.unavailableReason()
					};
					return passkey.registered() ? { text: t(`dev.${k}.has`) } : {
						text: t(`dev.${k}.none`),
						detail: t(`dev.${k}.enrol`)
					};
				},
				actions: () => [{
					id: "lock",
					label: t("phone.lockNow"),
					run: () => lock()
				}, ...passkey.registered() ? [{
					id: "forget",
					label: t("phone.forget"),
					kind: "danger",
					run: () => {
						passkey.forget();
						lock();
					}
				}] : []]
			},
			connection: {
				state: () => {
					const r = api$1.resolution(), pref = api$1.pref();
					return {
						text: r.detail || api$1.modeLabel(),
						choice: pref.kind,
						detail: pref.base || ""
					};
				},
				choices: () => [
					{
						value: "auto",
						label: t("phone.conn.auto")
					},
					{
						value: "fixtures",
						label: t("phone.conn.fixtures")
					},
					{
						value: "server",
						label: t("phone.conn.server")
					}
				],
				choose: async (v, url) => {
					if (v === "auto") api$1.useAutoDetect();
					else if (v === "fixtures") api$1.useFixtures();
					else {
						if (!/^https?:\/\//.test(String(url || ""))) return;
						api$1.setBaseUrl(url);
					}
					await api$1.reprobe();
					lock();
				}
			},
			about: () => t("phone.about", {
				shell: shellVersion() || "?",
				mode: api$1.modeLabel()
			})
		},
		slots: {}
	};
}
//#endregion
//#region web/ui/gate.jsx
function LangToggle({ onPick }) {
	const cur = lang();
	return /* @__PURE__ */ u("div", {
		class: "lang-toggle",
		role: "group",
		"aria-label": t("settings.language"),
		children: LANGS.map((l) => /* @__PURE__ */ u("button", {
			type: "button",
			class: l === cur ? "on" : "",
			"aria-pressed": l === cur,
			onClick: () => {
				setLang(l);
				onPick?.(l);
			},
			children: l.toUpperCase()
		}, l))
	});
}
function Gate({ name, sub, top, children }) {
	return /* @__PURE__ */ u("div", {
		class: "auth",
		children: /* @__PURE__ */ u("div", {
			class: "auth-card",
			children: [
				top,
				/* @__PURE__ */ u(Harbor, {}),
				/* @__PURE__ */ u("div", {
					class: "brand big",
					children: [/* @__PURE__ */ u(Logo, { size: 44 }), /* @__PURE__ */ u("div", { children: [/* @__PURE__ */ u("b", { children: name }), sub ? /* @__PURE__ */ u("small", { children: sub }) : null] })]
				}),
				children
			]
		})
	});
}
//#endregion
//#region web/src/lock.jsx
function Lock({ onIn, connection }) {
	const [, bump] = d(0);
	const redraw = () => bump((n) => n + 1);
	const [err, setErr] = d("");
	const [code, setCode] = d("");
	const [window_, setWindow] = d(null);
	const [where, setWhere] = d(false);
	const r = api$1.resolution();
	const server = r.mode === "server";
	const probing = r.mode === "probing";
	h(() => {
		api$1.ready().then(redraw);
	}, []);
	h(() => {
		if (probing || !passkey.available() || !passkey.registered()) return;
		if (!passkey.prepared() && !passkey.preparing() && !passkey.prepareError()) passkey.prepare().then(redraw, (e) => setErr(passkey.describe(e)));
	});
	h(() => {
		if (!server || !passkey.available() || passkey.registered()) return;
		passkey.enrolmentState().then(setWindow, (e) => setWindow({ error: String(e && e.message || e) }));
	}, [server]);
	const unlock = () => {
		if (passkey.unlocking()) return;
		setErr("");
		const p = passkey.open();
		redraw();
		p.then(() => onIn("passkey"), (e) => {
			setErr(passkey.describe(e));
			redraw();
		});
	};
	const enrol = async () => {
		setErr("");
		try {
			await passkey.register(server ? code : "");
			onIn("enrol");
		} catch (e) {
			setErr(String(e && e.message || e));
		}
	};
	const dev = passkey.device(), kind = devKind();
	return /* @__PURE__ */ u(Gate, {
		name: "ghostfleet",
		sub: t("lock.tagline"),
		top: /* @__PURE__ */ u(LangToggle, {}),
		children: [
			/* @__PURE__ */ u("div", {
				class: "gate-notes",
				children: [
					/* @__PURE__ */ u("p", {
						class: "muted small",
						children: r.detail
					}),
					!probing && !passkey.available() ? /* @__PURE__ */ u("p", {
						class: "warn",
						children: t("lock.unavailable", { why: passkey.unavailableReason() })
					}) : null,
					r.mode === "fixtures" ? /* @__PURE__ */ u("p", {
						class: "warn small",
						children: t("lock.fixturesGate")
					}) : null
				]
			}),
			probing ? null : /* @__PURE__ */ u("div", {
				class: "stack",
				children: [
					passkey.available() && !passkey.registered() && server ? /* @__PURE__ */ u(S$1, { children: [
						/* @__PURE__ */ u("p", {
							class: window_?.open ? "ok" : "muted",
							children: window_ == null ? t("lock.asking", { where: api$1.modeLabel() }) : window_.error ? t("lock.askFailed", { why: window_.error }) : window_.open ? t("lock.windowOpen", { client: window_.client }) : t("lock.windowClosed", { how: t(`dev.${kind}.enrol`) })
						}),
						/* @__PURE__ */ u("label", {
							class: "field",
							children: [/* @__PURE__ */ u("span", { children: t("lock.code") }), /* @__PURE__ */ u("input", {
								value: code,
								placeholder: "GP7CX-ZRDR5",
								autocapitalize: "characters",
								autocomplete: "one-time-code",
								onInput: (e) => setCode(e.currentTarget.value),
								onKeyDown: (e) => {
									if (e.key === "Enter" && code) enrol();
								}
							})]
						}),
						/* @__PURE__ */ u(Btn, {
							kind: "primary",
							disabled: !code,
							onClick: enrol,
							children: t(`dev.${kind}.enrolBtn`)
						})
					] }) : null,
					passkey.available() && !passkey.registered() && !server ? /* @__PURE__ */ u(Btn, {
						kind: "primary",
						onClick: enrol,
						children: t("lock.register")
					}) : null,
					passkey.available() && passkey.registered() ? /* @__PURE__ */ u(Btn, {
						kind: "primary",
						disabled: passkey.unlocking(),
						onClick: unlock,
						children: passkey.unlocking() ? t("lock.unlocking") : t("lock.unlock", { sensor: dev.sensor })
					}) : null,
					passkey.bypassAllowed() ? /* @__PURE__ */ u(Btn, {
						kind: "ghost",
						onClick: () => {
							passkey.bypass();
							onIn("bypass");
						},
						children: t("lock.bypass")
					}) : null,
					r.mode === "fixtures" && r.source === "probe" ? /* @__PURE__ */ u(Btn, {
						kind: "ghost",
						onClick: async () => {
							await api$1.reprobe();
							redraw();
						},
						children: t("lock.lookAgain")
					}) : null
				]
			}),
			err ? /* @__PURE__ */ u("p", {
				class: "err",
				role: "alert",
				children: err
			}) : null,
			/* @__PURE__ */ u("button", {
				type: "button",
				class: "link-btn",
				"aria-expanded": where,
				onClick: () => setWhere(!where),
				children: t("lock.where")
			}),
			where ? /* @__PURE__ */ u(Connection, {
				part: connection,
				onChange: redraw
			}) : null
		]
	});
}
//#endregion
//#region web/ui/modality.js
var MODIFIERS = /* @__PURE__ */ new Set([
	"Shift",
	"Control",
	"Alt",
	"AltGraph",
	"Meta",
	"CapsLock",
	"Fn",
	"FnLock",
	"Hyper",
	"Super",
	"OS"
]);
if (typeof document !== "undefined") {
	const root = document.documentElement;
	addEventListener("pointerdown", () => root.classList.add("by-pointer"), true);
	addEventListener("keydown", (e) => {
		if (MODIFIERS.has(e.key) || e.metaKey || e.ctrlKey) return;
		root.classList.remove("by-pointer");
	}, true);
}
//#endregion
//#region web/src/phone.jsx
var wantPlace = {
	"#jarvis": "/",
	"#waiting": "/queue",
	"#reviews": "/reviews"
}[location.hash] || null;
if (wantPlace) try {
	history.replaceState(null, "", location.pathname + location.search + "#/");
} catch {}
var linkPlace = !wantPlace && location.hash && location.hash !== "#/" && location.hash !== "#";
function Bar({ error, okAt }) {
	if (api$1.mode() === "fixtures") return /* @__PURE__ */ u("div", {
		class: "demo-bar",
		role: "status",
		children: t("lock.fixturesGate")
	});
	if (!error || error instanceof api$1.AuthError) return null;
	return /* @__PURE__ */ u("div", {
		class: "demo-bar off",
		role: "status",
		children: okAt ? t("phone.offline", { ago: ago((Date.now() - okAt) / 1e3) }) : t("phone.offlineNever")
	});
}
var atHome = () => /^#?\/?$/.test(location.hash || "");
function PushOffer() {
	const [want, setWant] = d(false);
	const [home, setHome] = d(atHome);
	h(() => {
		const f = () => setHome(atHome());
		addEventListener("hashchange", f);
		return () => removeEventListener("hashchange", f);
	}, []);
	h(() => {
		let live = true;
		(async () => {
			let laterAt = 0;
			try {
				laterAt = Number(localStorage.getItem("gf.push.later")) || 0;
			} catch {}
			const base = {
				server: api$1.mode() === "server",
				token: api$1.haveToken(),
				blocked: blockedReason(t),
				laterAt
			};
			if (!offerWanted({
				...base,
				on: false
			})) return;
			let on = true;
			try {
				on = !!(await state(t)).on;
			} catch {}
			if (live) setWant(offerWanted({
				...base,
				on
			}));
		})();
		return () => {
			live = false;
		};
	}, []);
	if (!want || !home) return null;
	const turnOn = async () => {
		try {
			await enable(t);
			setWant(false);
			toast(t("push.onNow"), "good");
		} catch (e) {
			if (permission() === "denied") setWant(false);
			toast(String(e && e.message || e), "bad");
		}
	};
	const later = () => {
		try {
			localStorage.setItem(LATER_KEY, String(Date.now()));
		} catch {}
		setWant(false);
	};
	return /* @__PURE__ */ u("div", {
		class: "notify-bar",
		role: "status",
		children: [/* @__PURE__ */ u("span", {
			class: "grow",
			children: t("push.offer")
		}), /* @__PURE__ */ u("span", {
			class: "notify-btns",
			children: [/* @__PURE__ */ u(Btn, {
				kind: "primary sm",
				onClick: turnOn,
				children: t("push.turnOn")
			}), /* @__PURE__ */ u(Btn, {
				kind: "ghost sm",
				onClick: later,
				children: t("push.notNow")
			})]
		})]
	});
}
function Phone() {
	const fleet = useFleet();
	const { data, error } = usePoll(() => fleet.projects(), 5e3, []);
	const okAt = A(0);
	h(() => {
		if (data) okAt.current = Date.now();
	}, [data]);
	h(() => {
		sync();
	}, []);
	return /* @__PURE__ */ u(FleetApp, {
		name: "ghostfleet",
		sub: t("lock.tagline"),
		projects: data?.projects,
		hosts: data?.hosts,
		frame: { banner: /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Bar, {
			error,
			okAt: okAt.current
		}), /* @__PURE__ */ u(PushOffer, {})] }) }
	});
}
function Root() {
	useLang();
	const [locked, setLocked] = d(true);
	const [ver, setVer] = d(0);
	const lock = () => {
		api$1.clearToken();
		unbind();
		setLocked(true);
	};
	const fleet = T(() => phoneAdapter({
		lock,
		go: go$1,
		place: () => null
	}), [ver]);
	h(() => {
		let hidByCeremony = false;
		const vis = () => {
			if (document.hidden) {
				hidByCeremony = passkey.busy();
				return;
			}
			if (!hidByCeremony) passkey.arm();
			hidByCeremony = false;
			if (!api$1.haveToken()) {
				if (!locked) lock();
				else tryAuto();
			}
		};
		document.addEventListener("visibilitychange", vis);
		return () => document.removeEventListener("visibilitychange", vis);
	}, [locked]);
	const landed = () => {
		passkey.release();
		const to = wantPlace || (linkPlace ? null : "/");
		wantPlace = null;
		linkPlace = false;
		if (to) try {
			history.replaceState(null, "", location.pathname + location.search + "#" + to);
		} catch {}
		setVer((v) => v + 1);
		setLocked(false);
		passkey.prepareFresh().catch(() => {});
	};
	const tryAuto = () => {
		if (document.hidden) return;
		passkey.autoUnlock().then((r) => {
			if (r === "ok") landed();
		}).catch(() => {});
	};
	h(() => {
		passkey.arm();
		passkey.resume().then((r) => {
			if (r === "ok") {
				linkPlace = true;
				landed();
				return;
			}
			if (r !== "offline") tryAuto();
		}).catch(() => {});
	}, []);
	if (locked) return /* @__PURE__ */ u(S$1, { children: [/* @__PURE__ */ u(Lock, {
		onIn: landed,
		connection: fleet.settings.connection
	}), /* @__PURE__ */ u(Toasts, {})] });
	return /* @__PURE__ */ u(FleetProvider, {
		adapter: fleet,
		children: /* @__PURE__ */ u(Phone, {}, ver)
	});
}
if ("serviceWorker" in navigator) {
	let hadController = !!navigator.serviceWorker.controller;
	navigator.serviceWorker.register("./sw.js").catch(() => {});
	askShellVersion();
	navigator.serviceWorker.addEventListener("message", (ev) => {
		const to = ev?.data?.open === "jarvis" ? "/" : ev?.data?.open === "waiting" ? "/queue" : null;
		if (to) {
			if (api$1.haveToken()) go$1(to);
			else wantPlace = to;
		}
	});
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hadController) {
			hadController = true;
			return;
		}
		const typing = () => {
			const a = document.activeElement;
			return !!a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && !!a.value;
		};
		const swap = () => {
			if (typing()) {
				setTimeout(swap, 5e3);
				return;
			}
			location.reload();
		};
		swap();
	});
}
var markStandalone = () => {
	try {
		document.documentElement.classList.toggle("standalone", standalone());
	} catch {}
};
markStandalone();
addEventListener("resize", markStandalone);
addEventListener("orientationchange", markStandalone);
R(/* @__PURE__ */ u(Root, {}), document.getElementById("app"));
//#endregion
