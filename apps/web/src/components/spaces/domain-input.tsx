'use client';

import { useState } from 'react';
import { normalizeDomain, PUBLIC_EMAIL_DOMAINS } from '@hive/shared';

const VALID = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Company email domain field with a live explanation of who will be able to join. */
export function DomainInput({ defaultValue = '' }: { defaultValue?: string }) {
  const [value, setValue] = useState(defaultValue);
  const domain = normalizeDomain(value);
  let hint = <>Optional. Everyone with a work email at this domain can join without an invite.</>;
  let tone = 'text-white/55';
  if (domain && PUBLIC_EMAIL_DOMAINS.includes(domain)) {
    hint = <>{domain} is a public email provider, so anyone could join. Use your company domain instead.</>;
    tone = 'text-rose-400';
  } else if (domain && VALID.test(domain)) {
    hint = <>✓ Anyone with an email ending in <strong>@{domain}</strong> can join without an invite.</>;
    tone = 'text-emerald-500';
  } else if (domain) {
    hint = <>Enter just the domain, like <strong>yourcompany.com</strong>. You can also paste an email or website.</>;
    tone = 'text-amber-500';
  }
  return <label className="block font-medium">Company email domain
    <input className="auth-input" name="allowed_email_domain" value={value} onChange={event => setValue(event.target.value)}
      placeholder="yourcompany.com" autoComplete="off" spellCheck={false} inputMode="url" />
    <span className={`text-sm font-normal ${tone}`} aria-live="polite">{hint}</span>
  </label>;
}
