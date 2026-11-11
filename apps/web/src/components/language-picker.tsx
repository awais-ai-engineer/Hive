'use client';

import { Select as UiSelect } from '@hive/ui';

import { LOCALES, useT } from '../lib/i18n';

export function LanguagePicker() {
  const { t, locale, setLocale } = useT();

  return (
    <div>
      <label
        htmlFor="hive-language"
        className="mb-2 block text-sm font-medium"
      >
        {t('settings.language')}
      </label>

      <UiSelect
        id="hive-language"
        name="language"
        aria-label={t('settings.language')}
        value={locale}
        onChange={(event) =>
          setLocale(event.target.value as (typeof LOCALES)[number]['code'])
        }
        className="auth-input"
      >
        {LOCALES.map((item) => (
          <option key={item.code} value={item.code}>
            {item.name}
          </option>
        ))}
      </UiSelect>
    </div>
  );
}
