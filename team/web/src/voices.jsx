import { useState, useEffect } from 'preact/hooks';
import { api } from './api.js';
import { speak, playSample, stopSpeaking } from './voice.js';
import { useAgent, setOption } from './agent.js';
import { Btn } from './ui.jsx';
import { t } from './i18n.js';
import { Icon } from './icon.jsx';

// Who answers out loud. The ones already on this machine, and Piper's from the internet: those
// are heard from their sample first, and only downloaded if they are liked.
const hello = () => t('vp.hello');

export function VoicePicker() {
  const S = useAgent();
  const [v, setV] = useState(null);
  const [playing, setPlaying] = useState('');
  const [bad, setBad] = useState('');
  const load = () => api.voices().then(setV).catch((e) => setBad(e.message));
  useEffect(() => { load(); return () => stopSpeaking(); }, []);

  // While a download runs, follow it; the voice that finishes becomes the one that answers.
  const job = v?.job && !v.job.error ? v.job : null;
  useEffect(() => {
    if (!job) return undefined;
    const timer = setTimeout(async () => {
      const n = await api.voices().catch(() => null);
      if (!n) return;
      setV(n);
      if (!n.job && n.voices.find(x => x.key === job.key)?.installed) setOption('voice', `piper:${job.key}`);
    }, 1000);
    return () => clearTimeout(timer);
  }, [v]);

  if (bad) return <p class="vp-bad small">{bad}</p>;
  if (!v) return <p class="muted small">{t('vp.loading')}</p>;

  const toggle = (id, start) => {
    if (playing === id) { stopSpeaking(); setPlaying(''); return; }
    setPlaying(id);
    start(() => setPlaying((p) => (p === id ? '' : p)));
  };
  const hear = (id) => toggle(id, (end) => speak(hello(), end, id));
  const sample = (x) => toggle(x.key, (end) => playSample(x.sample, end));
  const download = (key) => api.installVoice(key).then(load).catch((e) => setBad(e.message));
  const erase = async (x) => {
    if (S.voice === `piper:${x.key}`) setOption('voice', '');
    await api.deleteVoice(x.key).catch((e) => setBad(e.message));
    load();
  };
  const current = S.voice && [...v.kokoro.map(k => k.id), ...v.voices.filter(x => x.installed).map(x => `piper:${x.key}`)].includes(S.voice)
    ? S.voice : v.kokoro.find(k => k.default)?.id;
  const Pick = ({ id, children }) => (
    <label class="vp-pick">
      <input type="radio" name="gfw-voice" checked={current === id} onChange={() => setOption('voice', id)} />
      <span class="vp-name">{children}</span>
    </label>
  );
  const Listen = ({ id, onClick, label }) => <Btn kind="sm" aria-label={label} onClick={onClick}><Icon name={playing === id ? 'stop' : 'play'} /></Btn>;
  const local = v.voices.filter(x => x.installed), online = v.voices.filter(x => !x.installed);

  return (
    <div class="vp">
      <div class="vp-k small">{t('vp.title')}</div>
      {v.kokoro.map(k => (
        <div key={k.id} class="vp-row">
          <Pick id={k.id}>{k.name}<small>{k.who}</small></Pick>
          <Listen id={k.id} label={t('vp.listen', { name: k.name })} onClick={() => hear(k.id)} />
        </div>
      ))}
      {local.map(x => (
        <div key={x.key} class="vp-row">
          <Pick id={`piper:${x.key}`}>{x.name}<small>{x.place}</small></Pick>
          <Listen id={`piper:${x.key}`} label={t('vp.listen', { name: x.name })} onClick={() => hear(`piper:${x.key}`)} />
          <Btn kind="sm" aria-label={t('vp.delete', { name: x.name })} onClick={() => erase(x)}>✕</Btn>
        </div>
      ))}
      {online.length ? <div class="vp-k small">{t('vp.online')}</div> : null}
      {online.map(x => (
        <div key={x.key} class="vp-row">
          <span class="vp-name grow">{x.name}<small>{x.place} · {t('vp.quality', { q: x.quality })} · {x.mb} MB</small></span>
          <Listen id={x.key} label={t('vp.listen', { name: x.name })} onClick={() => sample(x)} />
          {job?.key === x.key
            ? <span class="muted small">{job.step === 'runtime' ? t('vp.preparing') : `${job.pct}%`}</span>
            : <Btn kind="sm" disabled={!!job} onClick={() => download(x.key)}>{t('vp.download')}</Btn>}
        </div>
      ))}
      {v.job?.error ? <p class="vp-bad small">{t('vp.failed', { name: v.job.name, why: v.job.error })}</p> : null}
    </div>
  );
}
