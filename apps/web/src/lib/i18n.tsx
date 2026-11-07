'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import en from '../locales/en.json';
import ur from '../locales/ur.json';
import hi from '../locales/hi.json';
import ar from '../locales/ar.json';
import de from '../locales/de.json';
import fr from '../locales/fr.json';
import es from '../locales/es.json';
import tr from '../locales/tr.json';
import zh from '../locales/zh.json';

export const LOCALES = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'ur', name: 'اردو', dir: 'rtl' },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'tr', name: 'Türkçe', dir: 'ltr' },
  { code: 'zh', name: '中文', dir: 'ltr' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

export type TranslationKey = keyof typeof en;

export type TranslationVars = Record<string, string | number>;

const translations = {
  en,
  ur,
  hi,
  ar,
  de,
  fr,
  es,
  tr,
  zh,
} as const;

const STORAGE_KEY = 'hive:locale';

const DEFAULT_LOCALE: LocaleCode = 'en';

type TextDirection = 'ltr' | 'rtl';

interface I18nContextValue {
  locale: LocaleCode;
  dir: TextDirection;
  setLocale: (locale: LocaleCode) => void;
  t: (key: TranslationKey, vars?: TranslationVars) => string;
}

interface I18nProviderProps {
  children: ReactNode;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function isSupportedLocale(value: string): value is LocaleCode {
  return LOCALES.some((locale) => locale.code === value);
}

function resolveLocale(value: string): LocaleCode {
  const normalized = value.toLowerCase().trim();

  if (isSupportedLocale(normalized)) {
    return normalized;
  }

  const baseLanguage = normalized.split('-')[0];

  if (isSupportedLocale(baseLanguage)) {
    return baseLanguage;
  }

  return DEFAULT_LOCALE;
}

function getDirection(locale: LocaleCode): TextDirection {
  return LOCALES.find((item) => item.code === locale)?.dir ?? 'ltr';
}

function interpolate(
  value: string,
  vars?: TranslationVars,
): string {
  if (!vars) return value;

  return value.replace(/\{(\w+)\}/g, (match, key: string) => {
    const replacement = vars[key];

    return replacement !== undefined
      ? String(replacement)
      : match;
  });
}

export function I18nProvider({ children }: I18nProviderProps) {
  // Keep the initial server and client render identical.
  const [locale, setLocaleState] = useState<LocaleCode>(
    DEFAULT_LOCALE,
  );

  // Read browser preferences only after mounting.
  useEffect(() => {
    let initialLocale = DEFAULT_LOCALE;

    try {
      const storedLocale = window.localStorage.getItem(STORAGE_KEY);

      if (storedLocale && isSupportedLocale(storedLocale)) {
        initialLocale = storedLocale;
      } else {
        initialLocale = resolveLocale(
          window.navigator.language || DEFAULT_LOCALE,
        );
      }
    } catch {
      // Storage can be unavailable in restricted browser environments.
      initialLocale = resolveLocale(
        window.navigator.language || DEFAULT_LOCALE,
      );
    }

    setLocaleState(initialLocale);

    document.documentElement.lang = initialLocale;
    document.documentElement.dir = getDirection(initialLocale);
  }, []);

  const setLocale = useCallback((nextLocale: LocaleCode) => {
    if (!isSupportedLocale(nextLocale)) return;

    setLocaleState(nextLocale);

    try {
      window.localStorage.setItem(STORAGE_KEY, nextLocale);
    } catch {
      // Continue working even when localStorage is unavailable.
    }

    document.documentElement.lang = nextLocale;
    document.documentElement.dir = getDirection(nextLocale);
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: TranslationVars): string => {
      const currentTranslations = translations[locale] as Record<
        string,
        string
      >;

      const englishTranslations = translations.en as Record<
        string,
        string
      >;

      const value =
        currentTranslations[key] ??
        englishTranslations[key] ??
        key;

      return interpolate(value, vars);
    },
    [locale],
  );

  const dir = getDirection(locale);

  const contextValue = useMemo<I18nContextValue>(
    () => ({
      locale,
      dir,
      setLocale,
      t,
    }),
    [locale, dir, setLocale, t],
  );

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT(): I18nContextValue {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error(
      'useT must be used inside an I18nProvider.',
    );
  }

  return context;
}
