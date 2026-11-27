'use client';

import { Button, Checkbox, Dialog, Input } from '@hive/ui';
import { useId, useMemo, useState } from 'react';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (poll: { question: string; options: string[]; multipleAnswers: boolean }) => Promise<boolean | void> | boolean | void;
};

/** A draft-preserving visual poll composer. The server remains authoritative for validation. */
export function PollCreateDialog({ open, onOpenChange, onCreate }: Props) {
  const baseId = useId();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multipleAnswers, setMultipleAnswers] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cleaned = useMemo(() => options.map(option => option.trim()).filter(Boolean), [options]);

  const updateOption = (index: number, value: string) => setOptions(current => current.map((option, position) => position === index ? value : option));
  const removeOption = (index: number) => setOptions(current => current.length <= 2 ? current : current.filter((_, position) => position !== index));
  async function submit() {
    const title = question.trim();
    if (!title) { setError('Enter a poll question.'); return; }
    if (cleaned.length < 2) { setError('Add at least two options.'); return; }
    if (new Set(cleaned.map(option => option.toLocaleLowerCase())).size !== cleaned.length) { setError('Each option must be different.'); return; }
    setBusy(true); setError('');
    try {
      const created = await onCreate({ question: title, options: cleaned, multipleAnswers });
      if (created === false) return;
      setQuestion(''); setOptions(['', '']); setMultipleAnswers(false); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create this poll.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Create a poll" description="Ask a clear question and add the choices your team can vote on." className="max-w-lg">
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Input id={`${baseId}-question`} label="Question" value={question} maxLength={200} autoFocus placeholder="What should we decide?" onChange={event => setQuestion(event.target.value)} />
      <fieldset className="space-y-2"><legend className="ui-label">Options</legend>{options.map((option, index) => <div key={`${baseId}-${index}`} className="flex items-center gap-2"><Input aria-label={`Option ${index + 1}`} value={option} maxLength={80} placeholder={`Option ${index + 1}`} onChange={event => updateOption(index, event.target.value)} /><Button type="button" variant="ghost" aria-label={`Remove option ${index + 1}`} disabled={options.length <= 2} onClick={() => removeOption(index)}>Remove</Button></div>)}
        {options.length < 10 && <Button type="button" variant="ghost" onClick={() => setOptions(current => [...current, ''])}>Add option</Button>}</fieldset>
      <label className="flex items-start gap-2 text-sm"><Checkbox checked={multipleAnswers} onChange={event => setMultipleAnswers(event.target.checked)} /><span><span className="font-medium">Allow multiple answers</span><span className="block text-xs text-white/60">Participants can vote for more than one option.</span></span></label>
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      <div className="ui-dialog-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Create poll</Button></div>
    </form>
  </Dialog>;
}
