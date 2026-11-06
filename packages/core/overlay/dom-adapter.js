// Browser adapter for apps without a framework adapter: plain DOM data, no components.
// It also documents the browser adapter contract; the bridge serves the configured adapter as /adapter.js and the
// overlay imports its default export:
//
//   name                          e.g. "angular"
//   hiddenAttributes              RegExp | null – framework attributes to leave out of descriptions and HTML
//   hiddenClasses                 RegExp | null – framework classes to leave out (e.g. Angular's ng-*)
//   owner(el)                     component whose template declares el: { name, selector, inputs } | null
//   component(el)                 component whose host element el is: { name, selector, inputs } | null
//   componentChain(el)            host selectors of the components around el, outermost first
//   componentHost(el)             host element of the component that owns el (◇ in the panel), else el
//   field(el)                     optional: data field el shows, from markers around it (a grid column), or null
//   warning()                     console hint when component info is unavailable (e.g. not in dev mode), or null
//   inspect(el, hints)            optional: live data state around el for the Data tab, or null. Read-only (never
//                                 mutates app state, never throws) and JSON-safe (depth, list and string lengths
//                                 capped). hints: { stores?: string[] } – store class names from the static lineage.
//     → { control, form, stores, context }, every part null/[] when not found:
//       control  the form control el is (or sits inside): { kind: 'reactive' | 'signal', name, value, valid, invalid,
//                pending, touched, dirty, disabled, required?, errors } – errors as { [kind]: details | true }
//       form     nearest form or group around el, else the owner's form: { kind, name, valid, invalid, pending,
//                touched, dirty, disabled, value, errors, invalidControls: [{ name, errors }],
//                controls: [{ name, value, valid, invalid, pending, touched, dirty, disabled, required?, errors }] }
//       stores   [{ name, property, component, signals: [{ name, value (preview), raw, count? }],
//                resources: [{ property, status, isLoading, error (string | null), value (raw) }] }]
//       context  model object el renders: { kind: 'input', component, property, raw }
//                | { kind: 'for', property: '$implicit', index, raw }

export default {
  name: 'dom',
  hiddenAttributes: null,
  hiddenClasses: null,
  owner: () => null,
  component: () => null,
  componentChain: () => [],
  componentHost: (el) => el,
  warning: () => null,
  inspect: () => null,
};
