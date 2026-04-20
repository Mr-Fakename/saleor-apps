"use client";

import { useAppBridge } from "@saleor/app-sdk/app-bridge";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { en, type TranslationKeys } from "./translations/en";
import { fr } from "./translations/fr";

type Translations = {
  en: TranslationKeys;
  fr: TranslationKeys;
};

const translations: Translations = {
  en,
  fr,
};

type SupportedLocale = keyof Translations;

const I18nContext = createContext<TranslationKeys>(en);

function getTranslations(locale: string | undefined): TranslationKeys {
  // Check if the locale starts with a supported language code
  if (locale?.startsWith("fr")) {
    return translations.fr;
  }
  // Default to English
  return translations.en;
}

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const { appBridgeState } = useAppBridge();
  const locale = appBridgeState?.locale;

  const t = useMemo(() => getTranslations(locale), [locale]);

  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useTranslations(): TranslationKeys {
  return useContext(I18nContext);
}
