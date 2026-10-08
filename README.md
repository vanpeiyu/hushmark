# Hushmark

[日本語](README.ja.md)

A live preview Markdown editor for VS Code that shows Markdown syntax only for the element under your cursor. You edit the document as plain Markdown text.

Line-level syntax, such as headings and blockquotes, is shown on the line with the cursor. Inline syntax, such as `code`, *emphasis*, and links, is shown only while the cursor touches that element. All other syntax is hidden and the text is styled.

![Hushmark: clicking bold text shows its markers, clicking a heading shows its # in the margin, then a task is checked, a list item is typed, a table cell is edited, and a heading is typed](docs/images/demo.gif)

## Features

- Headings, blockquotes, lists, and code keep their text in place whether their syntax is shown or hidden. The hidden syntax keeps its width, and the `#` of a heading is shown in the left margin. Emphasis and link syntax is hidden together with its width, because the remaining space would look like extra blanks. As a result, text after it on the same line moves only when the cursor enters that element.
- Letter spacing and line spacing follow the source. To keep the columns of a monospaced font aligned, the font size and side margins do not change per element. Only headings can use a larger font, and even then their height is a whole multiple of a body line.
- Vertical positions match the source lines. No space is added above or below blocks; the blank lines and ` ``` ` lines of the source become the space. A table header takes two lines (the header and the delimiter row), and each data row takes one line.
- Backgrounds and rules start at one left edge. Lines without leading spaces start slightly inside that edge, and lines with leading spaces start at least one character further in, so you can see whether a line is indented.
- Choose the look by combining a style (rules, backgrounds, rounded corners, and so on) with a color. The colors of each element are derived from the chosen color, and text meets readability contrast requirements against its background.
- The level of a heading is shown by a mark in the left margin, regardless of the font size.
- Emphasis works in Chinese, Japanese, and Korean text. Under the CommonMark rules, `**注意（readme.md 参照）。**の件` and `は**「重要」**です` are not emphasized, because the inside of the delimiter is punctuation and the outside is a CJK character. Like [markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly), Hushmark emphasizes them when the outside is a CJK character. When the inside is CJK punctuation, it also emphasizes them when the outside is a digit or a Latin letter (`**重要。**2つ目`). The same applies to `*` and `~~`.
- The document is never converted to another format, so saving keeps your Markdown formatting (list markers, spaces, and line endings) as written. Undo (Ctrl+Z) and redo (Ctrl+Y / Ctrl+Shift+Z) work as usual.
- Edits made in another editor (a split view or the text editor) do not corrupt the document even when they overlap with typing in this editor. When both change the same place at the same time, the characters typed in this editor are discarded and the view is updated to match the document.
- When another tool changes the file, the view is updated. If there are unsaved changes, the file is not reloaded and a notification appears instead; choose "Revert File" in the notification to discard the unsaved changes and load the file.
- Documents that cannot be written (such as an older version from git) cannot be edited. As in VS Code, a file that is read-only because of its file permissions is treated as read-only only when `files.readonlyFromPermissions` is enabled. `files.readonlyInclude` and `files.readonlyExclude` are also respected.
- The cursor and scroll positions are restored when you reload the window or restart VS Code.
- The UI is shown in English or Japanese, following the VS Code display language.
- Works in VS Code for the Web (vscode.dev and github.dev).

## Installation

Download `hushmark-<version>.vsix` from [Releases](https://github.com/vanpeiyu/hushmark/releases) and install it. To build a .vsix from source, see [CONTRIBUTING.md](CONTRIBUTING.md) (in Japanese).

- For your local VS Code, run "Extensions: Install from VSIX..." from the Command Palette and select the .vsix, or run:

  ```sh
  code --install-extension hushmark-<version>.vsix
  ```

- With Remote - SSH, the extension runs on the remote side where the files are, so install it on the remote host as well. Run "Extensions: Install from VSIX..." in the window opened with Remote - SSH, or run the following on the remote host (find `<commit>` with `ls ~/.vscode-server/cli/servers/`):

  ```sh
  ~/.vscode-server/cli/servers/Stable-<commit>/server/bin/code-server --install-extension hushmark-<version>.vsix
  ```

## Usage

- Open a Markdown file with "Open in Live Editor" in the editor title bar or in the Explorer context menu.
- To go back to the text editor, use "Open in Text Editor" in the editor title bar.
- To always open Markdown files in this editor, add the following to your settings:

  ```json
  "workbench.editorAssociations": { "*.md": "hushmark.editor" }
  ```

## Display and editing

| Element | When the cursor is not on it | Actions |
|---|---|---|
| Heading | Hides `#`. Depending on the style, shows a mark for the level in the left margin. A line with only `##` is not a heading | ― |
| Emphasis, link | Hides the syntax together with its width. A reference link such as `[foo]` becomes a link only when the document defines `[foo]: URL` (as in CommonMark) | Ctrl+Click (Cmd+Click on macOS) opens the link. A link to `#heading` moves to that heading (anchors follow the same rules as GitHub). For `other.md#heading`, the cursor moves to the heading when the file opens in this editor |
| Image | Not rendered in the document; the source is shown in a muted color (rendering it would break the alignment with source lines). Inside table cells, the alt text is shown | Hover to show the image in a popup. Ctrl+Click opens the image file |
| Inline code | Hides `` ` `` and uses its width as padding of the background | ― |
| Two trailing spaces (line break) | Shows a faint dot where the spaces are | ― |
| List, task | Shows a bullet in place of `-` and a checkbox in place of `[ ]` | Click a checkbox to toggle between `[ ]` and `[x]` |
| Table | Shows a table | See "Editing tables" below |
| Code block | Hides ` ``` ` and uses those lines as space above and below (the language name is shown at the start of the line). Highlights syntax for each language | ― |
| Blockquote, horizontal rule | Hides the syntax | ― |
| Front matter | No styling | ― |

The following VS Code editor settings (their values for Markdown) are respected. To apply them only to Markdown, put them inside `"[markdown]": { ... }`. Changes take effect immediately.

| Setting | Behavior |
|---|---|
| `editor.fontSize` | Font size |
| `editor.lineHeight` | Line height. Used when `hushmark.lineHeight` is less than 1. When `0` (default), 1.85 times the font size, which is wider than VS Code's automatic 1.35 times to suit CJK text |
| `editor.lineNumbers` | Line numbers. `off` hides them and `interval` shows every 10th line. `relative` is shown the same as `on`. For tables, each row shows the number of its line |
| `editor.wrappingIndent` | Indentation of wrapped lines. Except for `none`, the second and later lines of list items and blockquotes are aligned with the start of the text |
| `editor.tabSize` | Tab width |
| `editor.wordWrap` | Word wrap. `off` does not wrap; any other value (`on`, `wordWrapColumn`, `bounded`) wraps at the width of the view. Alt+Z toggles it on the spot (without changing the setting) |
| `editor.renderLineHighlight` | Background of the line with the cursor. With `line` or `all` (default `line`), a light background spans the full width of the line |
| `editor.renderLineHighlightOnlyWhenFocus` | When `true`, the line background is shown only while the editor has focus |

The keyboard shortcuts are the same as in the VS Code editor. Elsewhere in this README, keys are written for Windows and Linux. On macOS, read Ctrl as Cmd and Alt as Option unless noted otherwise.

| Key | macOS | Behavior |
|---|---|---|
| Ctrl+F / Ctrl+H | Cmd+F / Cmd+Option+F | Find / replace in the editor (see "Find" below) |
| Ctrl+Shift+F / Ctrl+Shift+H | Cmd+Shift+F / Cmd+Shift+H | Search / replace in VS Code's folder. The selected text becomes the search term |
| Ctrl+B | Cmd+B | Bold |
| Ctrl+I | Cmd+I | Italic |
| Alt+Z | Option+Z | Toggle word wrap |
| Paste a URL over selected text | Same | Turns the selected text into a link to that URL (`[text](URL)`), as in VS Code's Markdown text editor |
| Paste an image (Ctrl+V) | Same | Saves it as `image.png` (or `image-1.png` and so on if it exists) in the folder of the document and inserts an image link. When text was copied together with the image (such as Excel cells), the text is pasted |
| Drop from the Explorer while holding Shift | Same | Inserts a link to the file with a relative path (an image link for images). Images dropped from your OS file manager are saved and linked in the same way as pasted images |
| The key after Ctrl+K | The key after Cmd+K | Passed to VS Code as a chord (such as Ctrl+K Z) and not typed as a character |

The same keys work while you edit a table cell.

### Find

As with the find widget of the VS Code editor, it appears in the upper right.

| Action | macOS | Behavior |
|---|---|---|
| Ctrl+F | Cmd+F | Opens it. The selected text (within one line) becomes the search term |
| Type a search term | Same | Moves to the first match from the cursor position when the widget was opened |
| Enter / Shift+Enter, F3 / Shift+F3 | Also Cmd+G / Cmd+Shift+G | Next / previous match |
| Alt+C / Alt+W / Alt+R | Cmd+Option+C / W / R | Toggle match case / whole word / regular expression |
| Ctrl+H, or › at the left | Cmd+Option+F, or › at the left | Shows the replace field. In the replace field, Enter replaces one match and Ctrl+Alt+Enter (Cmd+Option+Enter on macOS) replaces all |
| Esc | Same | Closes it and returns to the editor |

Matches inside a table are shown by highlighting the cells that contain them.

When you open a result of Search (Ctrl+Shift+F) with a double-click or Enter, this editor receives focus, but the cursor does not move to the match, because VS Code does not pass the position to custom editors.

### Editing tables

Tables are shown as tables, and only the cell you click is edited as source. Inside a cell, bold and link syntax is shown only while the cursor touches it, and long content wraps at the cell width. Column widths are fixed at their width just before editing starts and are recalculated when you leave the cell.

| Action | Behavior |
|---|---|
| Click a cell | Edits that cell from the clicked position |
| ↑ / ↓ on the line above or below a table | Edits a cell in the nearest row of the table |
| Tab / Shift+Tab | Next / previous cell. Tab in the last cell adds a row |
| Enter / Shift+Enter | Cell below / above. At the edge of the table, leaves the table |
| ↑ / ↓ | Moves between wrapped lines in a cell. ↑ on the first line or ↓ on the last line first moves to the start or end of the cell, and pressing it again moves to the cell above or below |
| Esc | Stops editing and moves to the line below the table |
| Type `\|` | Escapes it as `\|` so that it does not split the cell |

When you hover over a table, the following buttons appear in its upper right.

- "+ Row" and "+ Column": add a row or a column
- "Source": shows the whole table as Markdown source. It returns to the table view when the cursor leaves the table. Change alignment (`:--:`) or delete rows and columns here

## Settings

Choose the look with two settings: the preview style and the color. Any combination works.

| Setting | Description |
|---|---|
| `hushmark.previewStyle` | Preview style. `soft` (default) is a friendly look with rounded shapes and colored rules and fills; `minimal` uses almost no color or fills; `reference` labels headings with tags such as "H1" and frames tables and code |
| `hushmark.previewColor` | Preview color: `green`, `cyan`, `blue`, `purple`, `pink`, `orange`, `sepia`, `mono` (monochrome, default), or `custom` |
| `hushmark.previewColorScheme` | Light or dark preview. `auto` (default) follows the VS Code theme. `light` and `dark` fix a light or dark background |
| `hushmark.previewCustomColor` | The color for `custom` (`#rrggbb`, default `#3366cc`). The colors of each element are derived from its hue and saturation |
| `hushmark.colorCustomizations` | Overrides the colors of individual elements (see "Overriding individual colors" below) |
| `hushmark.headingSize` | Heading size. `body` (all headings the same size as body text), `medium` (default; h1 and h2 take two body lines), or `large` (h1 takes three body lines; h2 and h3 take two) |
| `hushmark.fontFamily` | Font (a CSS `font-family` value). When empty (default), VS Code's editor font (`editor.fontFamily`) is used. Example: `"HackGen Console NF", monospace` |
| `hushmark.lineHeight` | Line height as a multiple of the font size. When less than 1 (default `0`), `editor.lineHeight` is used |
| `hushmark.rightMargin` | Adds a margin on the right side of the editor as wide as the one on the left (default `true`) |
| `hushmark.debugLog` | Writes debug logs to the "Hushmark" output panel |

Setting changes take effect immediately.

With a VS Code high contrast theme, the colors of the VS Code theme are always used, regardless of these settings.

### Overriding individual colors

Write the colors to change in `hushmark.colorCustomizations`. As with VS Code's `workbench.colorCustomizations`, colors written inside `"[color name]"` are used only while that color (`hushmark.previewColor`) is selected.

```json
"hushmark.colorCustomizations": {
  "link": "#3366cc",
  "[sepia]": {
    "blockBackground": "#f0e6d2"
  }
}
```

The following colors can be changed.

| Name | Where it is used |
|---|---|
| `background` / `foreground` / `strongForeground` / `mutedForeground` | Background, text, text of headings and bold, text of syntax and blockquotes |
| `border` / `strongBorder` | Thin rules and slightly darker rules (where they are used depends on the style) |
| `blockBackground` / `codeBackground` | Background of code blocks and front matter, background of inline code |
| `accent` / `softAccent` / `accentBackground` | Accent (checkboxes, the cell being edited, bullets in `soft`, and so on), soft accent (rules in `soft`), accent background (blockquotes and table headers in `soft`) |
| `link` | Links |
| `highlight` | Highlighter under bold text (`soft`) |
| `selection` / `lineHighlight` | Selection, background of the line with the cursor |

## Uninstalling

Installing the extension creates the following.

| Item | Location |
|---|---|
| The installed extension | `~/.vscode/extensions/local.hushmark-<version>` (under `~/.vscode-server/extensions/` on a Remote - SSH host) |
| Settings you wrote | `workbench.editorAssociations` and `hushmark.*` in your user settings |

Run the following command, and remove `"*.md": "hushmark.editor"` from `workbench.editorAssociations` and any `hushmark.*` settings from your user settings.

```sh
code --uninstall-extension local.hushmark
```

For what development creates (such as the Docker image used for tests), see [CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

- On a line whose syntax is hidden, clicking at a boundary such as the end of bold text places the cursor outside the syntax. After the syntax appears, click again to place the cursor where you want.
- No space is added above or below headings. Add blank lines to the source if you want space.
- Images are not rendered in the document (they are shown only on hover). Mermaid diagrams and math are not rendered; they are shown as source.
- The undo history belongs to this editor only. Edits made in the other side of a split view or in the text editor cannot be undone with Ctrl+Z in this editor.
- In very long documents or large tables, typing and cursor movement may become slow.

## License

MIT License (see `LICENSE`).

The .vsix bundles packages such as CodeMirror. Their license texts are in `media/dist/THIRD_PARTY_LICENSES.txt` inside the .vsix (generated at build time).
