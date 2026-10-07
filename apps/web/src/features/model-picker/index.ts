/**
 * The model picker on its own: one panel for every place a model is chosen (the composer's
 * chip, Settings' default model, an automation's model), with its source groups, Legacy models,
 * discovery errors and Refresh models. It reads only the catalog, never accounts, so any slice
 * can use it.
 */
export { ModelPickerPanel } from "./model-picker-panel.tsx";
/** One provider's model as a form field, opening the same picker; its code loads on render. */
export { LazyModelField as ModelField } from "./lazy-model-field.tsx";
export type { ModelFieldProps } from "./model-field.tsx";
export { useRefreshModels, type RefreshModels } from "./use-refresh-models.ts";
