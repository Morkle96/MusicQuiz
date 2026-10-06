# Quiz library

Place exported quiz JSON files in this folder, then add each file to `manifest.json`:

```json
{
  "name": "Summer Party Quiz",
  "file": "summer-party.json"
}
```

The browser cannot list a GitHub Pages folder automatically, so the manifest is the list used by the quiz dropdown. Set `"default": true` on one entry to load it at startup when there is no quiz saved in the browser.
