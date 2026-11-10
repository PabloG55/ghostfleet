// server/router.mjs — the dispatcher behind the assistant. Everything said to it comes here
// first. It splits what was said into tasks and gives each ONE destination, or a question. Words
// used to pick the project by sounding like its name, so a sentence that merely mentioned a
// project moved the conversation there and the next one landed somewhere else.
//   It only decides; it does not do the work or send anything. Whatever cannot be confirmed here
// (a project that does not exist, low confidence, Claude not answering) stays as a task that
// asks where it goes. Asking is the failure mode, never sending, and never dropping the words.
import { claudeJson } from './claude.mjs';
import { visibleProjects } from './access.mjs';
import { t as tr } from '../shared/i18n/index.js';

const SURE = 0.8;
const TASK = {
  type: 'object',
  properties: {
    pending_id: { type: 'string', description: 'si esto resuelve una tarea sin destino, su id; si no, vacío' },
    project: { type: 'string', description: 'exacto como en la lista; vacío si no sabes' },
    session: { type: 'string', description: 'una sesión de ese proyecto; vacío = su líder' },
    title: { type: 'string', description: 'la tarea en 3 a 6 palabras' },
    text: { type: 'string', description: 'las palabras de la persona para esta tarea, literales' },
    listed: { type: 'boolean', description: 'false si es un comentario o una respuesta, no un pedido nuevo' },
    context: { type: 'string', description: 'palabras anteriores, literales, que el destino necesita para entender; vacío si no hacen falta' },
    confidence: { type: 'number' },
    question: { type: 'string', description: 'si no estás seguro: la pregunta, corta, para leerse en voz alta' },
    options: { type: 'array', items: { type: 'string' }, description: 'si no estás seguro: 2 a 4 proyectos candidatos' },
    why: { type: 'string', description: 'por qué ahí, en menos de 12 palabras' },
  },
  required: ['pending_id', 'project', 'session', 'title', 'text', 'listed', 'context', 'confidence', 'question', 'options', 'why'],
};
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tasks', 'go', 'ask'] },
    tasks: { type: 'array', items: TASK },
    project: { type: 'string', description: 'si action es go' },
    session: { type: 'string', description: 'si action es go y nombró una sesión' },
    question: { type: 'string', description: 'si action es ask' },
    why: { type: 'string' },
  },
  required: ['action', 'tasks', 'project', 'session', 'question', 'why'],
};

const system = (projects, notes) => `Eres el despachador de ghostfleet team. Una persona maneja por voz una flota de sesiones de Claude Code organizadas por proyecto; cada proyecto tiene un líder y workers. Habla de corrido y salta entre proyectos. Todo lo que dice pasa primero por ti: lo separas en tareas y decides a dónde va cada una. No haces el trabajo ni contestas lo que pide.

Respondes con action:
- "tasks": lo normal. Una entrada en tasks por cada cosa que pide.
- "go": solo quiere ir a ver un proyecto, sin pedir nada.
- "ask": es ruido o no se entiende nada ("[MÚSICA]", palabras sueltas): question con qué quiso decir, y tasks vacío.

Reglas:
1. Separa bien. Cosas para proyectos distintos son tareas distintas; dos cosas del mismo tema para el mismo destino son una sola. Ninguna tarea va a dos destinos y ninguna cosa pedida se queda afuera. En text van sus palabras literales, sin resumir.
2. Prefiere preguntar antes que mandar mal: un envío equivocado es mucho peor que una pregunta. confidence es honesto, de 0 a 1. Si no llega a ${SURE} deja la tarea igual, con project vacío, question y options: queda anotada esperando destino y no se manda.
3. Nombrar un proyecto no lo hace destino. Distingue a quién le habla de sobre qué habla: "en toolbox me dijeron que acme-web falla" puede ser para cualquiera de los dos, y "te está diciendo lo de X" sigue la conversación en curso.
4. Sin decir lugar, si sigue el mismo tema o solo asiente ("perfecto", "dale", "avísame cuando acabe"), va al destino del último envío. Si cambia de tema sin decir dónde y nada lo indica, pregunta.
5. listed es false para lo que no es un pedido nuevo: asentir, comentar, contestar lo que un líder preguntó. Va igual al destino, pero no ocupa lugar en la lista. Un pedido de trabajo siempre es listed true.
6. Una corrección ("no, eso era para X", "mándale esto a X") va a X, y en context copias literal lo que dijo antes y X necesita para entender.
7. Si hay tareas sin destino y esta frase dice a dónde va una, devuelve esa tarea con su pending_id y el destino. Si habla de otra cosa, no las toques.
8. El texto viene de un dictado con errores: compara nombres por cómo suenan ("acmi web" es acme-web, "tul box" es toolbox, "gosfleet" es ghostfleet). Ignora ruidos como "[MÚSICA]" dentro de una frase con sentido.
9. La página abierta es una pista, no una orden.
${notes ? `\nNotas de la persona sobre sus proyectos (mandan sobre lo demás):\n${notes}\n` : ''}
La flota ahora:
${projects.map(p => `- ${p.name}: ${p.sessions.map(s => `${s.name}${s.lead ? ' (líder)' : ''} [${s.status}]`).join(', ') || 'sin sesiones abiertas'}`).join('\n')}

${tr('route.replyIn')}`;

const WHO = { me: 'PERSONA', ai: 'LÍDER', event: 'PÁGINA' };
const line = (e) => `${WHO[e.kind] || 'PÁGINA'}: ${String(e.text || '').slice(0, 400)}`;

const titled = (text) => String(text).trim().split(/\s+/).slice(0, 6).join(' ');

// `projects` is the whole fleet; only what `user` can see reaches the model or can be chosen, so
// a project without access is never named, suggested or sent to (perform() checks again).
export async function route({ text, feed = [], open = [], page, user, projects: all, notes }) {
  const projects = visibleProjects(user, all);
  const waiting = open.filter(t => t.status === 'ask');
  const going = open.filter(t => t.status !== 'ask' && !t.hidden);
  const prompt = [
    feed.length ? `Conversación reciente:\n${feed.slice(-14).map(line).join('\n')}` : 'Sin conversación previa.',
    going.length ? `Tareas abiertas:\n${going.map(t => `- ${t.title} → ${t.project}${t.session ? `/${t.session}` : ''}`).join('\n')}` : '',
    waiting.length ? `Tareas sin destino todavía:\n${waiting.map(t => `- id ${t.id}: "${t.text.slice(0, 300)}"`).join('\n')}` : '',
    page?.project ? `Página abierta: ${page.project}${page.session ? `, sesión ${page.session}` : ''}.` : 'Página abierta: inicio.',
    `Lo que acaba de decir: "${String(text).slice(0, 4000)}"`,
  ].filter(Boolean).join('\n\n');
  const r = await claudeJson({ system: system(projects, notes), prompt, schema: SCHEMA, timeoutMs: 60000 });
  if (!r.ok) return { action: 'tasks', failed: r.text, tasks: [{ title: titled(text), text, project: '', session: '', listed: true, context: '', confidence: 0, options: [],
                      question: tr('route.failed'), why: tr('route.failedWhy') }] };
  return check(r.data, projects, text, waiting);
}

// What the model said, held to what is actually there.
export function check(d, projects, said = '', waiting = []) {
  const named = (n) => projects.find(p => p.name === n);
  if (d.action === 'ask') return { action: 'ask', question: d.question || tr('route.huh'), why: d.why || '' };
  if (d.action === 'go') {
    const p = named(d.project);
    if (p) return { action: 'go', project: p.name, session: p.sessions.some(s => s.name === d.session) ? d.session : '', why: d.why || '' };
    return { action: 'ask', question: tr('route.noProjectGo'), why: tr('route.said', { what: d.project }) };
  }
  const tasks = (d.tasks || []).map(t => task(t, projects, said, waiting));
  // Words that came in must come out as something: if it found no task, they wait for a place.
  if (!tasks.length) return { action: 'ask', question: d.question || tr('route.huh'), why: d.why || '' };
  return { action: 'tasks', tasks };
}
function task(t, projects, said, waiting) {
  const options = (t.options || []).filter(n => projects.some(p => p.name === n)).slice(0, 4);
  const base = { pending: waiting.some(w => w.id === t.pending_id) ? t.pending_id : '', title: t.title || titled(t.text || said), text: t.text || said,
                 listed: t.listed !== false, context: t.context || '', why: t.why || '', confidence: t.confidence };
  const unsure = (question, opts = options) => ({ ...base, listed: true, project: '', session: '', question, options: opts });
  if (!t.project) return unsure(t.question || tr('route.which'));
  const p = projects.find(x => x.name === t.project);
  if (!p) return unsure(tr('route.noProject'));
  if (t.confidence < SURE) return unsure(t.question || tr('route.isFor', { project: p.name }), options.length ? options : [p.name]);
  const s = t.session ? p.sessions.find(x => x.name === t.session) : null;
  if (t.session && !s) return unsure(tr('route.noSession', { project: p.name, session: t.session }), [p.name]);
  return { ...base, project: p.name, session: s && !s.lead ? s.name : '' };
}
