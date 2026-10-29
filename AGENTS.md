# Repository Instructions

## Khan Academy verification

- Never inject a large generated KAP+ program directly into the Khan Academy
  editor, including through `kapplus:verify` or another local browser-driven
  editor check. The editor attempts to render the entire generated source and
  can hang or crash before the program runs.
- Validate large programs through the chunked publication path instead: load
  only the compact Khan bootstrap, verify the CDN chunks, inspect loader status,
  and check runtime errors after the loader reaches `ready`.
- Direct editor execution is acceptable only for small fixtures and compact
  regression programs that cannot overload the editor.
