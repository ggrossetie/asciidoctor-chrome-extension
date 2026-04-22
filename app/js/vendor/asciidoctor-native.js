var version = "0.1.0";
const packageJson = {
	version: version};

// ESM conversion of rx.rb
// A collection of regular expression constants used by the parser.
//
// Ruby → JavaScript regex engine differences handled here:
//
//   Ruby \p{Alpha}  → JS \p{Alphabetic}  (Unicode Binary Property, requires 'u' flag)
//   Ruby \p{Alnum}  → JS \p{Alphabetic}\p{N}   (inside […]) or [\p{Alphabetic}\p{N}]
//   Ruby \p{Word}   → JS \p{Alphabetic}\p{N}\p{Pc}  (Letter + Number + Connector Punct)
//   Ruby \p{Blank}  → JS \p{Zs}\t  (Unicode Space_Separator + tab)
//   Ruby CC_ALL (. with /m)  → [\s\S]  (no 's' flag needed)
//   Ruby CC_ANY (.)          → .
//   Ruby ^ / $               → always line anchors in Ruby; in JS only with 'm' flag
//   Ruby \A / \Z             → ^ / $ in JS (string anchors, no 'm' flag)
//
// IMPORTANT – 'u' flag and unset back-references:
//   Without 'u': \n to an unset group matches the empty string (Ruby-compatible).
//   With    'u': \n to an unset group fails (stricter).
//   → InlineLinkRx is intentionally kept WITHOUT the 'u' flag because it relies on
//     the (?!\2) trick (negative lookahead of an unset back-reference) to guard the
//     angle-bracket branch.  All other patterns use 'u'.

// ── Character class string constants ─────────────────────────────────────────
// CC_* → raw content for insertion INSIDE a character class: [${CC_WORD}]
// CG_* → complete character class GROUP for standalone use:  ${CG_WORD}
//
// These are runtime strings whose value contains real regex syntax (single
// backslashes) so that String.raw`…${CC_WORD}…` produces correct regex source.

const CC_ALL   = '[\\s\\S]';   // any char including newlines (Ruby . with /m flag)
const CC_ANY   = '.';          // any char except newlines
const CC_EOL   = '$';          // end of line / string

// \p{Alphabetic} ≈ Ruby \p{Alpha} – all Unicode alphabetic characters
const CC_ALPHA  = '\\p{Alphabetic}';    // inside [...]
const CG_ALPHA  = '\\p{Alphabetic}';    // standalone (unary property, no brackets needed)

// \p{Alphabetic}\p{N} ≈ Ruby \p{Alnum} – alphabetics + all Unicode numbers
const CC_ALNUM  = '\\p{Alphabetic}\\p{N}';    // inside [...]
const CG_ALNUM  = '[\\p{Alphabetic}\\p{N}]';  // standalone group

// \p{Alphabetic}\p{N}\p{Pc} ≈ Ruby \p{Word}
// Letter + Number + Connector Punctuation (underscore, undertie, …)
const CC_WORD   = '\\p{Alphabetic}\\p{N}\\p{Pc}';    // inside [...]
const CG_WORD   = '[\\p{Alphabetic}\\p{N}\\p{Pc}]';  // standalone group

// \p{Zs}\t ≈ Ruby \p{Blank} – Unicode Space_Separator category + tab
const CG_BLANK  = '[\\p{Zs}\\t]';  // standalone group

// Attribute list pattern fragment: \[([^\[\]]+)\]
// Ruby: QuoteAttributeListRxt = %(\\[([^\\[\\]]+)\\])
const QuoteAttributeListRxt = '\\[([^\\[\\]]+)\\]';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a regex with the Unicode flag ('u'), enabling \p{…} property escapes.
 * @param {string} src        - Regex source string (use String.raw for easy authoring).
 * @param {string} extraFlags - Additional flags, e.g. 'm' for multiline ^ / $
 */
const ru$1 = (src, extraFlags = '') => new RegExp(src, `u${extraFlags}`);

/**
 * Escape all regex metacharacters in str (equivalent to Regexp.escape in Ruby).
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a lazy-initialised regex map, mirroring Ruby's Hash.new { |h,k| h[k] = … }.
 * Accessing map[key] creates and caches the regex for that key.
 */
function makeLazyRxMap(buildFn) {
  const cache = new Map();
  return new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      if (!cache.has(key)) cache.set(key, buildFn(key));
      return cache.get(key)
    },
  })
}

// ── Document header ───────────────────────────────────────────────────────────

// Matches the author info line immediately following the document title.
//
// Examples
//
//   Doc Writer <doc@example.com>
//   Mary_Sue Brontë
//
const AuthorInfoLineRx = ru$1(
  String.raw`^(${CG_WORD}[${CC_WORD}\-'.]*)(?: +(${CG_WORD}[${CC_WORD}\-'.]*))?` +
  String.raw`(?: +(${CG_WORD}[${CC_WORD}\-'.]*))?(?:[ ]+<([^>]+)>)?$`
);

// Matches the delimiter that separates multiple authors.
//
// Examples
//
//   Doc Writer; Junior Writer
//
const AuthorDelimiterRx = /;(?: |$)/;

// Matches the revision info line immediately following the author info line.
//
// Examples
//
//   v1.0
//   2013-01-01
//   v1.0, 2013-01-01: Ring in the new year release
//
const RevisionInfoLineRx = /^(?:[^\d{]*(.*?),)? *(?!:)(.*?)(?: *(?!^),?: *(.*))?$/;

// Matches the title and volnum in the manpage doctype.
//
// Examples
//
//   = asciidoctor(1)
//   = asciidoctor ( 1 )
//
const ManpageTitleVolnumRx = /^(.+?) *\( *(.+?) *\)$/;

// Matches the name and purpose in the manpage doctype.
//
// Examples
//
//   asciidoctor - converts AsciiDoc source files to HTML, DocBook and other formats
//
const ManpageNamePurposeRx = /^(.+?) +- +(.+)$/;

// ── Preprocessor directives ───────────────────────────────────────────────────

// Matches a conditional preprocessor directive (ifdef, ifndef, ifeval, endif).
//
// Examples
//
//   ifdef::basebackend-html[]
//   ifeval::["{asciidoctor-version}" >= "0.1.0"]
//   endif::[]
//
const ConditionalDirectiveRx = /^(\\)?(ifdef|ifndef|ifeval|endif)::(\S*?(?:([,+])\S*?)?)\[(.+)?\]$/;

// Matches a restricted (safe) eval expression.
//
// Examples
//
//   "{asciidoctor-version}" >= "0.1.0"
//
const EvalExpressionRx = /^(.+?) *([=!><]=|[><]) *(.+)$/;

// Matches an include preprocessor directive.
//
// Examples
//
//   include::chapter1.ad[]
//   include::example.txt[lines=1;2;5..10]
//
const IncludeDirectiveRx = /^(\\)?include::([^\s\[](?:[^\[]*[^\s\[])?)\[(.+)?\]$/;

// Matches a trailing tag directive in an include file.
//
// Examples
//
//   // tag::try-catch[]
//   // end::try-catch[]
//
// NOTE: 'm' flag required so that $ matches end-of-line (not only end-of-string) in JS.
// NOTE: accounts for \r in Windows line endings.
const TagDirectiveRx = /\b(?:tag|(e)nd)::(\S+?)\[\](?=$|[ \r])/m;

// ── Attribute entries and references ─────────────────────────────────────────

// Matches a document attribute entry.
//
// Examples
//
//   :foo: bar
//   :First Name: Dan
//   :sectnums!:
//
const AttributeEntryRx = ru$1(String.raw`^:(!?${CG_WORD}[^:]*):(?:[ \t]+(.*))?$`);

// Matches invalid characters in an attribute name.
const InvalidAttributeNameCharsRx = ru$1(String.raw`[^${CC_WORD}\-]`);

// Matches a pass inline macro surrounding an attribute entry value.
//
// Examples
//
//   pass:[text]
//   pass:a[{a} {b} {c}]
//
// NOTE: ^ / $ are string anchors here (no 'm' flag). [\s\S]* allows multi-line values.
const AttributeEntryPassMacroRx = /^pass:([a-z]+(?:,[a-z-]+)*)?\[([\s\S]*)\]$/;

// Matches an inline attribute reference.
//
// Examples
//
//   {foobar}
//   {counter:sequence-name:1}
//   {set:foo:bar}
//
const AttributeReferenceRx = ru$1(
  String.raw`(\\)?\{(${CG_WORD}[${CC_WORD}\-]*|(set|counter2?):.*?)(\\)?\}`
);

// ── Paragraphs and delimited blocks ──────────────────────────────────────────

// Matches an anchor (id + optional reference text) on a line above a block.
//
// Examples
//
//   [[idname]]
//   [[idname,Reference Text]]
//
const BlockAnchorRx = ru$1(
  String.raw`^\[\[(?:|([${CC_ALPHA}_:][${CC_WORD}\-:.]*)(?:, *(.+))?)\]\]$`
);

// Matches an attribute list above a block element.
//
// Examples
//
//   [quote, Adam Smith, Wealth of Nations]
//   [{lead}]
//
const BlockAttributeListRx = ru$1(String.raw`^\[(|[${CC_WORD}.#%{,"'].*)\]$`);

// Combined pattern matching either a block anchor or a block attribute list.
const BlockAttributeLineRx = ru$1(
  String.raw`^\[(?:|[${CC_WORD}.#%{,"'].*|\[(?:|[${CC_ALPHA}_:][${CC_WORD}\-:.]*(?:, *.+)?)\])\]$`
);

// Matches a title above a block.
//
// Examples
//
//   .Title goes here
//
const BlockTitleRx = /^\.(\.?[^ \t.].*)$/;

// Matches an admonition label at the start of a paragraph.
//
// Examples
//
//   NOTE: Just a little note.
//   TIP: Don't forget!
//
const AdmonitionParagraphRx = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):[ \t]+/;

// Matches a literal paragraph (line preceded by at least one space or tab).
//
// Examples
//
//   <SPACE>Foo
//   <TAB>Foo
//
const LiteralParagraphRx = /^([ \t]+.*)$/;

// ── Section titles ────────────────────────────────────────────────────────────

// Matches an Atx (single-line) section title.
//
// Examples
//
//   == Foo
//   == Foo ==
//
const AtxSectionTitleRx = /^(=={0,5})[ \t]+(.+?)(?:[ \t]+\1)?$/;

// Extended Atx section title supporting the Markdown variant (#).
const ExtAtxSectionTitleRx = /^(=={0,5}|##{0,5})[ \t]+(.+?)(?:[ \t]+\1)?$/;

// Matches the first line of a Setext (two-line) section title.
// Must not start with '.' and must contain at least one alphanumeric character.
const SetextSectionTitleRx = ru$1(String.raw`^((?!\.).*?${CG_ALNUM}.*)$`);

// Matches an anchor inside a section title.
//
// Examples
//
//   Section Title [[idname]]
//   Section Title [[idname,Reference Text]]
//
const InlineSectionAnchorRx = ru$1(
  String.raw` (\\)?\[\[([${CC_ALPHA}_:][${CC_WORD}\-:.]*)(?:, *(.+?))?\]\]$`
);

// Matches invalid ID characters in a section title.
// NOTE: Uppercase excluded; expression is run only on a lowercase string.
const InvalidSectionIdCharsRx = ru$1(
  String.raw`<[^>]+>|&(?:[a-z][a-z]+\d{0,2}|#\d\d\d{0,4}|#x[\da-f][\da-f][\da-f]{0,3});|[^ ${CC_WORD}\-.]+?`
);

// Matches an explicit section level style like sect1.
const SectionLevelStyleRx = /^sect\d$/;

// ── Lists ─────────────────────────────────────────────────────────────────────

// Detects the start of any list item.
//
// NOTE: Check only up to the blank character since non-whitespace follows.
// IMPORTANT: Must agree with the per-list-type regexps or the parser will hang.
const AnyListRx = /^(?:[ \t]*(?:-|\*\**|\.\.*|\u2022|\d+\.|[a-zA-Z]\.|[IVXivx]+\))[ \t]|(?!\/\/[^\/])[ \t]*[^ \t].*?(?::::{0,2}|;;)(?:$|[ \t])|<(?:\d+|\.)>[ \t])/;

// Matches an unordered list item.
//
// Examples
//
//   * Foo
//   - Foo
//
const UnorderedListRx = /^[ \t]*(-|\*\**|\u2022)[ \t]+([\s\S]*)$/;

// Matches an ordered list item.
//
// Examples
//
//   . Foo    1. Foo    a. Foo    I. Foo
//
const OrderedListRx = /^[ \t]*(\.\.*|\d+\.|[a-zA-Z]\.|[IVXivx]+\))[ \t]+([\s\S]*)$/;

// Ordinal pattern for each ordered list type.
const OrderedListMarkerRxMap = {
  arabic:     /\d+\./,
  loweralpha: /[a-z]\./,
  lowerroman: /[ivx]+\)/,
  upperalpha: /[A-Z]\./,
  upperroman: /[IVX]+\)/,
};

// Matches a description list entry.
//
// Examples
//
//   foo::
//   foo:: The metasyntactic variable …
//
const DescriptionListRx = /^(?!\/\/[^\/])[ \t]*([^ \t].*?)(:::{0,2}|;;)(?:$|[ \t]+([\s\S]*)$)/;

// Matches a sibling description list item (excluding the delimiter given by key).
const DescriptionListSiblingRx = {
  '::':   /^(?!\/\/[^\/])[ \t]*([^ \t].*?[^:]|[^ \t:])(::)(?:$|[ \t]+([\s\S]*)$)/,
  ':::':  /^(?!\/\/[^\/])[ \t]*([^ \t].*?[^:]|[^ \t:])(:::)(?:$|[ \t]+([\s\S]*)$)/,
  '::::': /^(?!\/\/[^\/])[ \t]*([^ \t].*?[^:]|[^ \t:])(::::)(?:$|[ \t]+([\s\S]*)$)/,
  ';;':   /^(?!\/\/[^\/])[ \t]*([^ \t].*?)(;;)(?:$|[ \t]+([\s\S]*)$)/,
};

// Matches a callout list item.
//
// Examples
//
//   <1> Explanation
//   <.> Explanation with automatic number
//
const CalloutListRx = /^<(\d+|\.)>[ \t]+([\s\S]*)$/;

// Matches a callout reference inside literal text (applied line-by-line).
//
// Group layout:
//   1 – optional line-comment prefix (//  #  --  ;;)
//   2 – backslash escape
//   3 – optional XML comment delimiter (--)
//   4 – callout number or dot
//
const CalloutExtractRx = /((?:\/\/|#|--|;;) ?)?(\\)?<!?(|--)(\d+|\.)\3>(?=(?: ?\\?<!?\3(?:\d+|\.)\3>)*$)/m;

// Template string for CalloutExtractRxMap entries.
// Runtime value: (\\)?<()(\d+|\.)>(?=(?: ?\\?<(?:\d+|\.)>)*$)
// Note: 'm' flag added so $ matches end-of-line (Ruby regex default behaviour).
const CalloutExtractRxt = '(\\\\)?<()([\\d]+|\\.)>(?=(?: ?\\\\?<(?:\\d+|\\.)>)*$)';

// Lazy map: line-comment string → callout-extract regex.
// Mirrors Ruby: Hash.new { |h,k| h[k] = /(prefix)?#{CalloutExtractRxt}/ }
const CalloutExtractRxMap = makeLazyRxMap((key) => {
  const prefix = key ? `(${escapeRegex(key)} ?)?` : '()?';
  return new RegExp(`${prefix}${CalloutExtractRxt}`, 'm')
});

// Matches a callout reference when scanning source (special chars NOT yet replaced).
const CalloutScanRx = /\\?<!?(|--)(\d+|\.)\1>(?=(?: ?\\?<!?\1(?:\d+|\.)\1>)*$)/m;

// Matches a callout reference in HTML output (special chars already replaced).
//
// Group layout mirrors CalloutExtractRx.
// Note: 'm' flag so $ matches end-of-line, matching Ruby regex semantics.
const CalloutSourceRx = /((?:\/\/|#|--|;;) ?)?(\\)?&lt;!?(|--)(\d+|\.)\3&gt;(?=(?: ?\\?&lt;!?\3(?:\d+|\.)\3&gt;)*$)/m;

// Template string for CalloutSourceRxMap entries.
// Runtime value: (\\)?&lt;()(\d+|\.)&gt;(?=(?: ?\\?&lt;(?:\d+|\.)&gt;)*$)
const CalloutSourceRxt = '(\\\\)?&lt;()([\\d]+|\\.)&gt;(?=(?: ?\\\\?&lt;(?:\\d+|\\.)&gt;)*$)';

// Lazy map: line-comment string → callout-source regex.
const CalloutSourceRxMap = makeLazyRxMap((key) => {
  const prefix = key ? `(${escapeRegex(key)} ?)?` : '()?';
  return new RegExp(`${prefix}${CalloutSourceRxt}`, 'm')
});

// Dynamic map from list context to its regex.
const ListRxMap = {
  ulist:  UnorderedListRx,
  olist:  OrderedListRx,
  dlist:  DescriptionListRx,
  colist: CalloutListRx,
};

// ── Tables ────────────────────────────────────────────────────────────────────

// Parses the column spec (colspec) for a table.  Examples: 1*h,2*,^3e
const ColumnSpecRx = /^(?:(\d+)\*)?([<^>](?:\.[<^>]?)?|(?:[<^>]?\.)?[<^>])?(\d+%?|~)?([a-z])?$/;

// Parses the start of a cell spec.  Example: 2.3+<.>m
const CellSpecStartRx = /^[ \t]*(?:(\d+(?:\.\d*)?|(?:\d*\.)?\d+)([*+]))?([<^>](?:\.[<^>]?)?|(?:[<^>]?\.)?[<^>])?([a-z])?$/;

// Parses the end of a cell spec.
const CellSpecEndRx = /[ \t]+(?:(\d+(?:\.\d*)?|(?:\d*\.)?\d+)([*+]))?([<^>](?:\.[<^>]?)?|(?:[<^>]?\.)?[<^>])?([a-z])?$/;

// ── Block macros ──────────────────────────────────────────────────────────────

// Matches the custom block macro pattern.  Example: gist::123456[]
const CustomBlockMacroRx = ru$1(
  String.raw`^(${CG_WORD}[${CC_WORD}\-]*)::(|\S|\S.*?\S)\[(.+)?\]$`
);

// Matches an image, video or audio block macro.
//
// Examples
//
//   image::filename.png[Caption]
//   video::http://youtube.com/12345[Cats vs Dogs]
//
const BlockMediaMacroRx = /^(image|video|audio)::(\S|\S.*?\S)\[(.+)?\]$/;

// Matches the TOC block macro.  Examples: toc::[]  toc::[levels=2]
const BlockTocMacroRx = /^toc::\[(.+)?\]$/;

// ── Inline macros ─────────────────────────────────────────────────────────────

// Matches an anchor (id + optional reference text) in the flow of text.
//
// Examples
//
//   [[idname]]
//   [[idname,Reference Text]]
//   anchor:idname[]
//   anchor:idname[Reference Text]
//
// Group layout:
//   1 – backslash escape
//   2 – id  (double-bracket form)
//   3 – reftext  (double-bracket form)
//   4 – id  (anchor: macro form)
//   5 – reftext  (anchor: macro form)
//
const InlineAnchorRx = ru$1(
  String.raw`(\\)?(?:\[\[([${CC_ALPHA}_:][${CC_WORD}\-:.]*)(?:, *(.+?))? ?\]\]` +
  String.raw`|anchor:([${CC_ALPHA}_:][${CC_WORD}\-:.]*)\[(?:\]|([\s\S]*?[^\\])\]))`
);

// Scans for a non-escaped anchor in the flow of text.
const InlineAnchorScanRx = ru$1(
  String.raw`(?:^|[^\\\[])\[\[([${CC_ALPHA}_:][${CC_WORD}\-:.]*)(?:, *(.+?))? ?\]\]` +
  String.raw`|(?:^|[^\\])anchor:([${CC_ALPHA}_:][${CC_WORD}\-:.]*)\[(?:\]|(.*?[^\\])\])`
);

// Scans for a leading, non-escaped anchor.
const LeadingInlineAnchorRx = ru$1(
  String.raw`^\[\[([${CC_ALPHA}_:][${CC_WORD}\-:.]*)(?:, *(.+?))?\]\]`
);

// Matches a bibliography anchor at the start of a list item.
//
// Examples
//
//   [[[Fowler_1997]]] Fowler M. ...
//
const InlineBiblioAnchorRx = ru$1(
  String.raw`^\[\[\[([${CC_ALPHA}_:][${CC_WORD}\-:.]*)(?:, *(.+?))?\]\]\]`
);

// Matches an inline e-mail address.
//
//   doc.writer@example.com
//
const InlineEmailRx = ru$1(
  String.raw`([\\>:/])?${CG_WORD}(?:&amp;|[${CC_WORD}\-.%+])*` +
  String.raw`@${CG_ALNUM}[${CC_ALNUM}_\-.]*\.[a-zA-Z]{2,5}\b`
);

// Matches an inline footnote macro (may span multiple lines).
//
// Examples
//
//   footnote:[text]
//   footnote:id[text]
//   footnoteref:[id,text]  (legacy)
//
// NOTE: [\s\S]*? allows multiline content (Ruby /m + CC_ALL).
// NOTE: (?!</a>) avoids matching inside an anchor tag.
const InlineFootnoteMacroRx = ru$1(
  String.raw`\\?footnote(?:(ref):|:([${CC_WORD}\-]+)?)\[(?:|([\s\S]*?[^\\]))\](?!</a>)`
);

// Matches an image or icon inline macro (may span multiple lines).
//
// Examples
//
//   image:filename.png[Alt Text]
//   icon:github[large]
//
const InlineImageMacroRx = /\\?i(?:mage|con):([^:\s\[](?:[^\n\[]*[^\s\[])?)\[(|[\s\S]*?[^\\])\]/;

// Matches an indexterm inline macro (may span multiple lines).
//
// Examples
//
//   indexterm:[Tigers,Big cats]
//   (((Tigers,Big cats)))
//   ((Tigers))
//
const InlineIndextermMacroRx = /\\?(?:(indexterm2?):\[([\s\S]*?[^\\])\]|\(\(([\s\S]+?)\)\)(?!\)))/;

// Matches either the kbd or btn inline macro (may span multiple lines).
//
// Examples
//
//   kbd:[F3]     kbd:[Ctrl+Shift+T]     btn:[Save]
//
const InlineKbdBtnMacroRx = /(\\)?(kbd|btn):\[([\s\S]*?[^\\])\]/;

// Matches an implicit link and the link inline macro.
//
// Examples
//
//   https://github.com
//   https://github.com[GitHub]
//   <https://github.com>
//   link:https://github.com[]
//
// NOTE: This is the Opal/JS variant of the pattern.
//   Group 2 captures ':' inside a lookahead from the &lt;<protocol> branch.
//   (?!\2) then guards the &gt;-terminated branch: when group 2 IS ':',
//   the guard prevents matching '://' at the start of the path; when group 2
//   is UNSET (other prefix branches), (?!\2) expands to (?!"") which ALWAYS
//   FAILS – correctly preventing the &gt; branch for non-&lt; prefixes.
//
// *** NO 'u' FLAG: the (?!\2) guard relies on unset back-references matching
//     the empty string, which only holds in non-Unicode mode. ***
//
// Group layout:
//   1 – prefix (^, link:, blank, \\?&lt; or punctuation)
//   2 – ':' captured by lookahead  (only when prefix is \\?&lt;)
//   3 – URL scheme + ://
//   4 – target before [   (formal macro)
//   5 – attrlist           (formal macro, may be empty)
//   6 – target before &gt; (angle-bracket autolink, requires &lt; prefix)
//   7 – target             (bare autolink)
//   8 – last non-terminating char of bare target
//
const InlineLinkRx = /(^|link:|[ \t\u00a0]|\\?&lt;(?=\\?(?:https?|file|ftp|irc)(:))|[>\(\)\[\];"'])(\\?(?:https?|file|ftp|irc):\/\/)(?:([^\s\[\]]+)\[(|[\s\S]*?[^\\])\]|(?!\2)([^\s]+?)&gt;|([^\s\[\]<]*([^\s,.?!\[\]<\)])))/m;

// Matches a link or e-mail inline macro (may span multiple lines).
//
// Examples
//
//   link:path[label]
//   mailto:doc.writer@example.com[]
//
const InlineLinkMacroRx = /\\?(?:link|(mailto)):(|[^:\s\[][^\s\[]*)\[(|[\s\S]*?[^\\])\]/;

// Matches the name of a macro.
const MacroNameRx = ru$1(String.raw`^${CG_WORD}[${CC_WORD}\-]*$`);

// Matches a stem (and alternatives) inline macro (may span multiple lines).
//
// Examples
//
//   stem:[x != 0]
//   latexmath:[\sqrt{4} = 2]
//
const InlineStemMacroRx = /\\?(stem|(?:latex|ascii)math):([a-z]+(?:,[a-z-]+)*)?\[([\s\S]*?[^\\])\]/;

// Matches a menu inline macro (may span multiple lines).
//
// Examples
//
//   menu:File[Save As...]
//   menu:View[Page Style > No Style]
//
const InlineMenuMacroRx = ru$1(
  String.raw`\\?menu:(${CG_WORD}|[${CC_WORD}&][^\n\[]*[^\s\[])` +
  String.raw`\[ *(?:|([\s\S]*?[^\\]))\]`
);

// Matches an implicit menu inline macro.
//
// Examples
//
//   "File > New..."
//
const InlineMenuRx = ru$1(String.raw`\\?"([${CC_WORD}&][^"]*?[ \n]+&gt;[ \n]+[^"]*)"`);

// Matches an inline passthrough (may span multiple lines).
//
// Examples
//
//   +text+
//   [x-]+text+
//   `text`  (compat only)
//
// Group layout (false / non-compat):
//   1 – preceding context or escape boundary
//   2 – '[' captured by lookahead (back-reference trick for attribute list detection)
//   3 – x- / 'attrlist x-' content
//   4 – QuoteAttributeListRxt content
//   5 – optional backslash before opening delimiter
//   6 – full quoted span (including delimiters)
//   7 – opening/closing delimiter (+ or `)
//   8 – span content
//
// Group layout (true / compat):
//   1 – preceding char or start-of-line
//   2 – ($) end-of-string sentinel  (never matches in inline text, preserves group count)
//   3 – empty group paired with sentinel
//   4 – QuoteAttributeListRxt content
//   5 – optional backslash before opening delimiter
//   6 – full quoted span
//   7 – opening/closing delimiter (`)
//   8 – span content
//
// NOTE: 'u' flag used, but the 'm' flag is also set so that ^ is a line anchor.
//   Unset optional back-references (\5?) with 'u' flag: the '?' quantifier
//   allows 0 occurrences, so the match continues even when the group is unset.
//
const InlinePassRx = {
  false: [
    '+',
    '-]',
    ru$1(
      String.raw`((?:^|[^${CC_WORD};:\\])(?=(\[)|\+)|\\(?=\[)|(?=\\\+))` +
      String.raw`(?:\2(x-|[^\[\]]+ x-)\]|(?:` + QuoteAttributeListRxt + String.raw`)?(?=(\\)?\+))` +
      String.raw`(\5?(\+|` + '`' + String.raw`)(\S|\S` + CC_ALL + String.raw`*?\S)\7)(?!${CG_WORD})`,
      'm'
    ),
  ],
  true: [
    '`',
    null,
    ru$1(
      String.raw`(^|[^` + '`' + String.raw`${CC_WORD}])(?:($)()|(?:` + QuoteAttributeListRxt + String.raw`)(?=(\\?)))?` +
      String.raw`(\5?(` + '`' + String.raw`)([^` + '`' + String.raw`\s]|[^` + '`' + String.raw`\s]` + CC_ALL + String.raw`*?\S)\7)(?![` + '`' + String.raw`${CC_WORD}])`,
      'm'
    ),
  ],
};

// Matches several variants of the passthrough inline macro (may span multiple lines).
//
// Examples
//
//   +++text+++
//   $$text$$
//   pass:quotes[text]
//   pass:[]
//
// Group layout:
//   1 – optional backslash before attribute list
//   2 – attribute list content  (QuoteAttributeListRxt)
//   3 – backslash(es) before delimiter  (0–2)
//   4 – delimiter: +++, ++, or $$
//   5 – content between delimiters  (\4 closes)
//   6 – backslash before pass: macro
//   7 – subs list after pass:
//   8 – content inside pass:[…]
//
const InlinePassMacroRx = new RegExp(
  `(?:(?:(\\\\?)${QuoteAttributeListRxt})?(\\\\{0,2})(\\+\\+\\+?|\\$\\$)([\\s\\S]*?)\\4|(\\\\?)pass:([a-z]+(?:,[a-z-]+)*)?\\[(|[\\s\\S]*?[^\\\\])\\])`
);

// Matches an xref (cross-reference) inline macro (may span multiple lines).
//
// Examples
//
//   <<id,reftext>>
//   xref:id[reftext]
//
// NOTE: { included to support targets beginning with an attribute reference.
// NOTE: Special characters are already entity-encoded in the matched text.
//
// Group layout:
//   1 – target of <<…>> form
//   2 – target of xref:…[] form
//   3 – link text inside xref:…[…]
//
const InlineXrefMacroRx = ru$1(
  String.raw`\\?(?:&lt;&lt;([${CC_WORD}#/.:{]` + CC_ALL + String.raw`*?)&gt;&gt;` +
  String.raw`|xref:([${CC_WORD}#/.:{]` + CC_ALL + String.raw`*?)\[(?:\]|(` + CC_ALL + String.raw`*?[^\\])\]))`
);

// ── Layout ────────────────────────────────────────────────────────────────────

// Matches a trailing + preceded by at least one space, forcing a hard line break.
//
// Examples
//
//   Humpty Dumpty sat on a wall, +
//   Humpty Dumpty had a great fall.
//
// NOTE: 'm' flag required so that ^ / $ are line anchors (not string anchors) in JS.
const HardLineBreakRx = /^(.*) \+$/m;

// Matches a Markdown horizontal rule.
//
// Examples
//
//   --- or - - -
//   *** or * * *
//   ___ or _ _ _
//
const MarkdownThematicBreakRx = /^ {0,3}([-*_])( *)\1\2\1$/;

// Matches an AsciiDoc or Markdown horizontal rule, or an AsciiDoc page break.
//
// Examples
//
//   '''  <<<  ---  ***  ___
//
const ExtLayoutBreakRx = /^(?:'{3,}|<{3,}|([-*_])( *)\1\2\1)$/;

// ── General ───────────────────────────────────────────────────────────────────

// Matches consecutive blank lines.
const BlankLineRx = /\n{2,}/;

// Matches whitespace escaped by a backslash.
//
// Examples
//
//   three\ blind\ mice
//
const EscapedSpaceRx = /\\([ \t\n])/;

// Detects text that may contain replaceable characters.
const ReplaceableTextRx = /[&']|--|\.\.\.|\([CRT]M?\)/;

// Matches a whitespace delimiter (space, tab, newline).
// Replicates the parsing rules of Ruby %w strings.
//
// TODO: Replace with /(?<!\\)[ \t\n]+/ when lookbehind is universally available.
const SpaceDelimiterRx = /([^\\])[ \t\n]+/;

// Matches a + or - modifier in a subs list.
const SubModifierSniffRx = /[+-]/;

// Matches one or more consecutive digits at the end of a line.
//
// Examples
//
//   docbook5   html5
//
const TrailingDigitsRx = /\d+$/;

// Detects strings that resemble URIs.
//
// Examples
//
//   http://domain    https://domain    file:///path    data:info
//
//   NOT c:/sample.adoc or c:\sample.adoc
//
// NOTE: ^ is used as a string-start anchor (no 'm' flag), equivalent to Ruby \A.
const UriSniffRx = ru$1(String.raw`^${CG_ALPHA}[${CC_ALNUM}.+\-]+:\/{0,2}`);

// Detects XML tags.
const XmlSanitizeRx = /<[^>]+>/;

// ESM conversion of lib/asciidoctor.rb
//
// Defines all module-level constants and re-exports every regex constant from
// rx.js so that other modules can import everything from this single file.
//
// Omissions vs. the Ruby source
//   - Ruby-encoding constants (UTF_8, BOM_BYTES_*) – JS strings are always UTF-16.
//   - File-mode strings (FILE_READ_MODE, …) – Ruby open(2) semantics, no JS equivalent.
//   - ROOT_DIR / LIB_DIR / DATA_DIR / USER_HOME – computed via import.meta.url below
//     for Node.js; silently empty in environments where the URL API is unavailable.
//   - const_missing / autoload – Ruby metaprogramming, not applicable in JS.
//   - Compliance – defined in ./compliance.js (imported separately by substitutors.js).
//   - RUBY_ENGINE / RUBY_ENGINE_OPAL – not applicable in JS.


// Local helper – same as the one inside rx.js (not exported there).
const ru = (src, flags = '') => new RegExp(src, `u${flags}`);

// ── SafeMode ─────────────────────────────────────────────────────────────────
// Mirrors the Asciidoctor::SafeMode Ruby module.
const _safeModeNamesByValue = { 0: 'unsafe', 1: 'safe', 10: 'server', 20: 'secure' };

const SafeMode = {
  UNSAFE: 0,
  SAFE: 1,
  SERVER: 10,
  SECURE: 20,

  // Returns the numeric value for a safe-mode name string, or undefined.
  valueForName(name) {
    const key = String(name).toUpperCase();
    const v = SafeMode[key];
    return typeof v === 'number' ? v : undefined
  },

  // Alias for valueForName
  getValueForName(name) {
    return this.valueForName(name)
  },

  // Returns the lowercase name for a numeric safe-mode value, or undefined.
  nameForValue(value) {
    return _safeModeNamesByValue[value]
  },

  // Alias for nameForValue
  getNameForValue(value) {
    return this.nameForValue(value)
  },

  // Returns all safe-mode names in ascending value order.
  names() {
    return Object.values(_safeModeNamesByValue)
  },

  // Alias for names
  getNames() {
    return this.names()
  },
};

// ── File-system paths (Node.js only) ─────────────────────────────────────────
// In a browser / Deno / Opal-compiled context these will be empty strings.
let ROOT_DIR = '';
let LIB_DIR = '';
let DATA_DIR = '';
let USER_HOME = '';
try {
  LIB_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
  ROOT_DIR = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
  DATA_DIR = new URL('../../data', import.meta.url).pathname;
  // Prefer $HOME; fall back to $USERPROFILE (Windows) then process.cwd()
  if (typeof process !== 'undefined') {
    USER_HOME = process.env.HOME || process.env.USERPROFILE || (process.cwd ? process.cwd() : ''); // eslint-disable-line n/no-process-env
  }
} catch {
}

// ── Primitive constants ───────────────────────────────────────────────────────
// The newline character used for output.
const LF$1 = '\n';

// The null character used as an internal separator for attribute values.
const NULL = '\0';

// The tab character.
const TAB = '\t';

// Maximum safe integer (= Number.MAX_SAFE_INTEGER).
const MAX_INT = 9007199254740991;

// ── Document defaults ─────────────────────────────────────────────────────────
const DEFAULT_DOCTYPE = 'article';
const DEFAULT_BACKEND = 'html5';

const DEFAULT_STYLESHEET_KEYS = new Set(['', 'DEFAULT']);
const DEFAULT_STYLESHEET_NAME = 'asciidoctor.css';

// Maps legacy backend aliases to the canonical backend name.
const BACKEND_ALIASES = {
  html: 'html5',
  docbook: 'docbook5',
};

// Default page widths (points) used when computing absolute column widths.
const DEFAULT_PAGE_WIDTHS = { docbook: 425 };

// Default output file extensions per base backend.
const DEFAULT_EXTENSIONS = {
  html: '.html',
  docbook: '.xml',
  pdf: '.pdf',
  epub: '.epub',
  manpage: '.man',
  asciidoc: '.adoc',
};

// File extensions that are recognized as AsciiDoc documents.
// TODO: .txt should be deprecated
const ASCIIDOC_EXTENSIONS = {
  '.adoc': true,
  '.asciidoc': true,
  '.asc': true,
  '.ad': true,
  '.txt': true,
};

// ── Section titles ────────────────────────────────────────────────────────────
// Maps setext underline characters to section levels.
const SETEXT_SECTION_LEVELS = {
  '=': 0,
  '-': 1,
  '~': 2,
  '^': 3,
  '+': 4,
};

// ── Admonition ───────────────────────────────────────────────────────────────
const ADMONITION_STYLES = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);
const ADMONITION_STYLE_HEADS = new Set([...ADMONITION_STYLES].map((s) => s[0]));

// ── Block styles ──────────────────────────────────────────────────────────────
const PARAGRAPH_STYLES = new Set([
  'comment', 'example', 'literal', 'listing', 'normal', 'open', 'pass', 'quote',
  'sidebar', 'source', 'verse', 'abstract', 'partintro',
]);

const VERBATIM_STYLES = new Set(['literal', 'listing', 'source', 'verse']);

// ── Delimited blocks ──────────────────────────────────────────────────────────
// Maps delimiter string → [context, Set of alternative styles].
// Ruby symbols are represented as plain strings.
const DELIMITED_BLOCKS = {
  '--': ['open', new Set(['comment', 'example', 'literal', 'listing', 'pass', 'quote', 'sidebar', 'source', 'verse', 'admonition', 'abstract', 'partintro'])],
  '----': ['listing', new Set(['literal', 'source'])],
  '....': ['literal', new Set(['listing', 'source'])],
  '====': ['example', new Set(['admonition'])],
  '****': ['sidebar', new Set()],
  '____': ['quote', new Set(['verse'])],
  '++++': ['pass', new Set(['stem', 'latexmath', 'asciimath'])],
  '|===': ['table', new Set()],
  ',===': ['table', new Set()],
  ':===': ['table', new Set()],
  '!===': ['table', new Set()],
  '~~~~': ['open', new Set(['abstract', 'partintro'])],
  '////': ['comment', new Set()],
  '```': ['fenced_code', new Set()],
};

// First 2 characters of each delimiter → true (used for fast sniff).
const DELIMITED_BLOCK_HEADS = Object.fromEntries(
  Object.keys(DELIMITED_BLOCKS).map((k) => [k.slice(0, 2), true])
);

// 4-character delimiters only: delimiter → last character (used for tail matching).
const DELIMITED_BLOCK_TAILS = Object.fromEntries(
  Object.keys(DELIMITED_BLOCKS)
    .filter((k) => k.length === 4)
    .map((k) => [k, k[k.length - 1]])
);

// ── Captions ──────────────────────────────────────────────────────────────────
// Maps block context to the document attribute that holds its caption prefix.
// NOTE: 'figure' key is a string for historical reasons (used by image blocks).
const CAPTION_ATTRIBUTE_NAMES = {
  example: 'example-caption',
  figure: 'figure-caption',
  listing: 'listing-caption',
  table: 'table-caption',
};

// ── Layout breaks ─────────────────────────────────────────────────────────────
const LAYOUT_BREAK_CHARS = {
  "'": 'thematic_break',
  '<': 'page_break',
};

const MARKDOWN_THEMATIC_BREAK_CHARS = {
  '-': 'thematic_break',
  '*': 'thematic_break',
  '_': 'thematic_break',
};

const HYBRID_LAYOUT_BREAK_CHARS = {
  ...LAYOUT_BREAK_CHARS,
  ...MARKDOWN_THEMATIC_BREAK_CHARS,
};

// ── Lists ─────────────────────────────────────────────────────────────────────
const NESTABLE_LIST_CONTEXTS = ['ulist', 'olist', 'dlist'];

// Ordered list style names, in selection priority order.
const ORDERED_LIST_STYLES = ['arabic', 'loweralpha', 'lowerroman', 'upperalpha', 'upperroman'];

// Maps an ordered list style name to its CSS list-style-type keyword.
const ORDERED_LIST_KEYWORDS = {
  loweralpha: 'a',
  lowerroman: 'i',
  upperalpha: 'A',
  upperroman: 'I',
};

// ── Inline markers ────────────────────────────────────────────────────────────
const ATTR_REF_HEAD = '{';
const LIST_CONTINUATION = '+';
// NOTE AsciiDoc.py allows + to be preceded by TAB; Asciidoctor does not
const HARD_LINE_BREAK = ' +';
const LINE_CONTINUATION = ' \\';
const LINE_CONTINUATION_LEGACY = ' +';

// ── Math / STEM ───────────────────────────────────────────────────────────────
const BLOCK_MATH_DELIMITERS = {
  asciimath: ['\\$', '\\$'],
  latexmath: ['\\[', '\\]'],
};

const INLINE_MATH_DELIMITERS = {
  asciimath: ['\\$', '\\$'],
  latexmath: ['\\(', '\\)'],
};

// Maps STEM type aliases to canonical type names.
// Accessing an unknown key returns 'asciimath' (mirrors Ruby Hash#default).
const STEM_TYPE_ALIASES = new Proxy(
  { latexmath: 'latexmath', latex: 'latexmath', tex: 'latexmath' },
  { get: (target, key) => Object.prototype.hasOwnProperty.call(target, key) ? target[key] : 'asciimath' }
);

// ── Third-party library versions ──────────────────────────────────────────────
const FONT_AWESOME_VERSION = '4.7.0';
const HIGHLIGHT_JS_VERSION = '9.18.3';
const MATHJAX_VERSION = '2.7.9';

// ── Default document attributes ───────────────────────────────────────────────
const DEFAULT_ATTRIBUTES = {
  'appendix-caption': 'Appendix',
  'appendix-refsig': 'Appendix',
  'caution-caption': 'Caution',
  'chapter-refsig': 'Chapter',
  'example-caption': 'Example',
  'figure-caption': 'Figure',
  'important-caption': 'Important',
  'last-update-label': 'Last updated',
  'note-caption': 'Note',
  'part-refsig': 'Part',
  'prewrap': '',
  'sectids': '',
  'section-refsig': 'Section',
  'table-caption': 'Table',
  'tip-caption': 'Tip',
  'toc-placement': 'auto',
  'toc-title': 'Table of Contents',
  'untitled-label': 'Untitled',
  'version-label': 'Version',
  'warning-caption': 'Warning',
};

// Attributes that may be changed mid-document (e.g. sectnums toggling).
const FLEXIBLE_ATTRIBUTES = ['sectnums'];

// Predefined (intrinsic) attribute substitutions.
const INTRINSIC_ATTRIBUTES = {
  startsb: '[',
  endsb: ']',
  vbar: '|',
  caret: '^',
  asterisk: '*',
  tilde: '~',
  plus: '&#43;',
  backslash: '\\',
  backtick: '`',
  blank: '',
  empty: '',
  sp: ' ',
  'two-colons': '::',
  'two-semicolons': ';;',
  nbsp: '&#160;',
  deg: '&#176;',
  zwsp: '&#8203;',
  quot: '&#34;',
  apos: '&#39;',
  lsquo: '&#8216;',
  rsquo: '&#8217;',
  ldquo: '&#8220;',
  rdquo: '&#8221;',
  wj: '&#8288;',
  brvbar: '&#166;',
  pp: '&#43;&#43;',
  cpp: 'C&#43;&#43;',
  cxx: 'C&#43;&#43;',
  amp: '&',
  lt: '<',
  gt: '>',
};

// ── Quote substitutions ───────────────────────────────────────────────────────
// Each entry is a triple: [type, scope, RegExp].
// type  – string matching a Ruby symbol (e.g. 'strong', 'emphasis', …)
// scope – 'unconstrained' | 'constrained'
//
// Ruby regex flag notes
//   /m in Ruby = dotAll (.  matches \n); handled by CC_ALL = '[\\s\\S]' → no 's' flag needed.
//   ^ / $ are always line anchors in Ruby → need JS 'm' flag when ^ or $ appears.
//   \p{…} Unicode properties require JS 'u' flag (provided by the ru() helper).
//
// Backtick character (U+0060) cannot appear literally inside a JS template literal,
// so it is injected via the BT variable in template expressions.
const BT = '\x60'; // U+0060 GRAVE ACCENT / backtick

const _normalQuoteSubs = [
  // **strong**
  ['strong', 'unconstrained',
    ru(String.raw`\\?(?:${QuoteAttributeListRxt})?\*\*(${CC_ALL}+?)\*\*`)],
  // *strong*
  ['strong', 'constrained',
    ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?\*(\S|\S${CC_ALL}*?\S)\*(?!${CG_WORD})`, 'm')],
  // "`double-quoted`"
  ['double', 'constrained',
    ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?"${BT}(\S|\S${CC_ALL}*?\S)${BT}"(?!${CG_WORD})`, 'm')],
  // '`single-quoted`'
  ['single', 'constrained',
    ru(String.raw`(^|[^${CC_WORD};:${BT}}])(?:${QuoteAttributeListRxt})?'${BT}(\S|\S${CC_ALL}*?\S)${BT}'(?!${CG_WORD})`, 'm')],
  // ``monospaced``
  ['monospaced', 'unconstrained',
    ru(String.raw`\\?(?:${QuoteAttributeListRxt})?${BT}${BT}(${CC_ALL}+?)${BT}${BT}`)],
  // `monospaced`
  ['monospaced', 'constrained',
    ru(String.raw`(^|[^${CC_WORD};:"'${BT}}])(?:${QuoteAttributeListRxt})?${BT}(\S|\S${CC_ALL}*?\S)${BT}(?![${CC_WORD}"'${BT}])`, 'm')],
  // __emphasis__
  ['emphasis', 'unconstrained',
    ru(String.raw`\\?(?:${QuoteAttributeListRxt})?__(${CC_ALL}+?)__`)],
  // _emphasis_
  ['emphasis', 'constrained',
    ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?_(\S|\S${CC_ALL}*?\S)_(?!${CG_WORD})`, 'm')],
  // ##mark##
  ['mark', 'unconstrained',
    ru(String.raw`\\?(?:${QuoteAttributeListRxt})?##(${CC_ALL}+?)##`)],
  // #mark#
  ['mark', 'constrained',
    ru(String.raw`(^|[^${CC_WORD}&;:}])(?:${QuoteAttributeListRxt})?#(\S|\S${CC_ALL}*?\S)#(?!${CG_WORD})`, 'm')],
  // ^superscript^
  ['superscript', 'unconstrained',
    ru(String.raw`\\?(?:${QuoteAttributeListRxt})?\^(\S+?)\^`)],
  // ~subscript~
  ['subscript', 'unconstrained',
    ru(String.raw`\\?(?:${QuoteAttributeListRxt})?~(\S+?)~`)],
];

// Compatibility mode overrides (entries replaced / inserted relative to normal).
const _compatQuoteSubs = [..._normalQuoteSubs];
// ``quoted''
_compatQuoteSubs[2] = ['double', 'constrained',
  ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?${BT}${BT}(\S|\S${CC_ALL}*?\S)''(?!${CG_WORD})`, 'm')];
// `quoted'
_compatQuoteSubs[3] = ['single', 'constrained',
  ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?${BT}(\S|\S${CC_ALL}*?\S)'(?!${CG_WORD})`, 'm')];
// ++monospaced++
_compatQuoteSubs[4] = ['monospaced', 'unconstrained',
  ru(String.raw`\\?(?:${QuoteAttributeListRxt})?\+\+(${CC_ALL}+?)\+\+`)];
// +monospaced+
_compatQuoteSubs[5] = ['monospaced', 'constrained',
  ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?\+(\S|\S${CC_ALL}*?\S)\+(?!${CG_WORD})`, 'm')];
// 'emphasis'  – inserted before original index 3 (single-quoted)
_compatQuoteSubs.splice(3, 0, ['emphasis', 'constrained',
  ru(String.raw`(^|[^${CC_WORD};:}])(?:${QuoteAttributeListRxt})?'(\S|\S${CC_ALL}*?\S)'(?!${CG_WORD})`, 'm')]);

// Keyed by boolean compat mode (false = normal, true = compat).
// JS object keys are always strings, so QUOTE_SUBS[false] coerces to QUOTE_SUBS['false'].
const QUOTE_SUBS = { false: _normalQuoteSubs, true: _compatQuoteSubs };

// ── Text replacements ─────────────────────────────────────────────────────────
// Each entry is a triple: [RegExp, replacement String, position hint].
// position hints: 'none' | 'leading' | 'bounding'
//
// NOTE: order of replacements is significant.
const REPLACEMENTS = [
  // (C)
  [/\\?\(C\)/, '&#169;', 'none'],
  // (R)
  [/\\?\(R\)/, '&#174;', 'none'],
  // (TM)
  [/\\?\(TM\)/, '&#8482;', 'none'],
  // foo -- bar  (either space may be a newline; ^ / $ are line anchors → 'm' flag)
  [/(?: |\n|^|\\)--(?: |\n|$)/m, '&#8201;&#8212;&#8201;', 'none'],
  // foo--bar
  [ru(String.raw`(${CG_WORD})\\?--(?=${CG_WORD})`), '&#8212;&#8203;', 'leading'],
  // ellipsis
  [/\\?\.\.\./, '&#8230;&#8203;', 'none'],
  // right single quote
  [/\\?`'/, '&#8217;', 'none'],
  // apostrophe (inside a word)
  [ru(String.raw`(${CG_ALNUM})\\?'(?=${CG_ALPHA})`), '&#8217;', 'leading'],
  // right arrow ->
  [/\\?-&gt;/, '&#8594;', 'none'],
  // right double arrow =>
  [/\\?=&gt;/, '&#8658;', 'none'],
  // left arrow <-
  [/\\?&lt;-/, '&#8592;', 'none'],
  // left double arrow <=
  [/\\?&lt;=/, '&#8656;', 'none'],
  // restore entities
  [/\\?(&)amp;((?:[a-zA-Z][a-zA-Z]+\d{0,2}|#\d\d\d{0,4}|#x[\da-fA-F][\da-fA-F][\da-fA-F]{0,3});)/, '', 'bounding'],
];

const constants = /*#__PURE__*/Object.freeze({
  __proto__: null,
  ADMONITION_STYLES: ADMONITION_STYLES,
  ADMONITION_STYLE_HEADS: ADMONITION_STYLE_HEADS,
  ASCIIDOC_EXTENSIONS: ASCIIDOC_EXTENSIONS,
  ATTR_REF_HEAD: ATTR_REF_HEAD,
  AdmonitionParagraphRx: AdmonitionParagraphRx,
  AnyListRx: AnyListRx,
  AttributeEntryPassMacroRx: AttributeEntryPassMacroRx,
  AttributeEntryRx: AttributeEntryRx,
  AttributeReferenceRx: AttributeReferenceRx,
  AtxSectionTitleRx: AtxSectionTitleRx,
  AuthorDelimiterRx: AuthorDelimiterRx,
  AuthorInfoLineRx: AuthorInfoLineRx,
  BACKEND_ALIASES: BACKEND_ALIASES,
  BLOCK_MATH_DELIMITERS: BLOCK_MATH_DELIMITERS,
  BlankLineRx: BlankLineRx,
  BlockAnchorRx: BlockAnchorRx,
  BlockAttributeLineRx: BlockAttributeLineRx,
  BlockAttributeListRx: BlockAttributeListRx,
  BlockMediaMacroRx: BlockMediaMacroRx,
  BlockTitleRx: BlockTitleRx,
  BlockTocMacroRx: BlockTocMacroRx,
  CAPTION_ATTRIBUTE_NAMES: CAPTION_ATTRIBUTE_NAMES,
  CC_ALL: CC_ALL,
  CC_ALNUM: CC_ALNUM,
  CC_ALPHA: CC_ALPHA,
  CC_ANY: CC_ANY,
  CC_EOL: CC_EOL,
  CC_WORD: CC_WORD,
  CG_ALNUM: CG_ALNUM,
  CG_ALPHA: CG_ALPHA,
  CG_BLANK: CG_BLANK,
  CG_WORD: CG_WORD,
  CalloutExtractRx: CalloutExtractRx,
  CalloutExtractRxMap: CalloutExtractRxMap,
  CalloutExtractRxt: CalloutExtractRxt,
  CalloutListRx: CalloutListRx,
  CalloutScanRx: CalloutScanRx,
  CalloutSourceRx: CalloutSourceRx,
  CalloutSourceRxMap: CalloutSourceRxMap,
  CalloutSourceRxt: CalloutSourceRxt,
  CellSpecEndRx: CellSpecEndRx,
  CellSpecStartRx: CellSpecStartRx,
  ColumnSpecRx: ColumnSpecRx,
  ConditionalDirectiveRx: ConditionalDirectiveRx,
  CustomBlockMacroRx: CustomBlockMacroRx,
  get DATA_DIR () { return DATA_DIR; },
  DEFAULT_ATTRIBUTES: DEFAULT_ATTRIBUTES,
  DEFAULT_BACKEND: DEFAULT_BACKEND,
  DEFAULT_DOCTYPE: DEFAULT_DOCTYPE,
  DEFAULT_EXTENSIONS: DEFAULT_EXTENSIONS,
  DEFAULT_PAGE_WIDTHS: DEFAULT_PAGE_WIDTHS,
  DEFAULT_STYLESHEET_KEYS: DEFAULT_STYLESHEET_KEYS,
  DEFAULT_STYLESHEET_NAME: DEFAULT_STYLESHEET_NAME,
  DELIMITED_BLOCKS: DELIMITED_BLOCKS,
  DELIMITED_BLOCK_HEADS: DELIMITED_BLOCK_HEADS,
  DELIMITED_BLOCK_TAILS: DELIMITED_BLOCK_TAILS,
  DescriptionListRx: DescriptionListRx,
  DescriptionListSiblingRx: DescriptionListSiblingRx,
  EscapedSpaceRx: EscapedSpaceRx,
  EvalExpressionRx: EvalExpressionRx,
  ExtAtxSectionTitleRx: ExtAtxSectionTitleRx,
  ExtLayoutBreakRx: ExtLayoutBreakRx,
  FLEXIBLE_ATTRIBUTES: FLEXIBLE_ATTRIBUTES,
  FONT_AWESOME_VERSION: FONT_AWESOME_VERSION,
  HARD_LINE_BREAK: HARD_LINE_BREAK,
  HIGHLIGHT_JS_VERSION: HIGHLIGHT_JS_VERSION,
  HYBRID_LAYOUT_BREAK_CHARS: HYBRID_LAYOUT_BREAK_CHARS,
  HardLineBreakRx: HardLineBreakRx,
  INLINE_MATH_DELIMITERS: INLINE_MATH_DELIMITERS,
  INTRINSIC_ATTRIBUTES: INTRINSIC_ATTRIBUTES,
  IncludeDirectiveRx: IncludeDirectiveRx,
  InlineAnchorRx: InlineAnchorRx,
  InlineAnchorScanRx: InlineAnchorScanRx,
  InlineBiblioAnchorRx: InlineBiblioAnchorRx,
  InlineEmailRx: InlineEmailRx,
  InlineFootnoteMacroRx: InlineFootnoteMacroRx,
  InlineImageMacroRx: InlineImageMacroRx,
  InlineIndextermMacroRx: InlineIndextermMacroRx,
  InlineKbdBtnMacroRx: InlineKbdBtnMacroRx,
  InlineLinkMacroRx: InlineLinkMacroRx,
  InlineLinkRx: InlineLinkRx,
  InlineMenuMacroRx: InlineMenuMacroRx,
  InlineMenuRx: InlineMenuRx,
  InlinePassMacroRx: InlinePassMacroRx,
  InlinePassRx: InlinePassRx,
  InlineSectionAnchorRx: InlineSectionAnchorRx,
  InlineStemMacroRx: InlineStemMacroRx,
  InlineXrefMacroRx: InlineXrefMacroRx,
  InvalidAttributeNameCharsRx: InvalidAttributeNameCharsRx,
  InvalidSectionIdCharsRx: InvalidSectionIdCharsRx,
  LAYOUT_BREAK_CHARS: LAYOUT_BREAK_CHARS,
  LF: LF$1,
  get LIB_DIR () { return LIB_DIR; },
  LINE_CONTINUATION: LINE_CONTINUATION,
  LINE_CONTINUATION_LEGACY: LINE_CONTINUATION_LEGACY,
  LIST_CONTINUATION: LIST_CONTINUATION,
  LeadingInlineAnchorRx: LeadingInlineAnchorRx,
  ListRxMap: ListRxMap,
  LiteralParagraphRx: LiteralParagraphRx,
  MARKDOWN_THEMATIC_BREAK_CHARS: MARKDOWN_THEMATIC_BREAK_CHARS,
  MATHJAX_VERSION: MATHJAX_VERSION,
  MAX_INT: MAX_INT,
  MacroNameRx: MacroNameRx,
  ManpageNamePurposeRx: ManpageNamePurposeRx,
  ManpageTitleVolnumRx: ManpageTitleVolnumRx,
  MarkdownThematicBreakRx: MarkdownThematicBreakRx,
  NESTABLE_LIST_CONTEXTS: NESTABLE_LIST_CONTEXTS,
  NULL: NULL,
  ORDERED_LIST_KEYWORDS: ORDERED_LIST_KEYWORDS,
  ORDERED_LIST_STYLES: ORDERED_LIST_STYLES,
  OrderedListMarkerRxMap: OrderedListMarkerRxMap,
  OrderedListRx: OrderedListRx,
  PARAGRAPH_STYLES: PARAGRAPH_STYLES,
  QUOTE_SUBS: QUOTE_SUBS,
  QuoteAttributeListRxt: QuoteAttributeListRxt,
  REPLACEMENTS: REPLACEMENTS,
  get ROOT_DIR () { return ROOT_DIR; },
  ReplaceableTextRx: ReplaceableTextRx,
  RevisionInfoLineRx: RevisionInfoLineRx,
  SETEXT_SECTION_LEVELS: SETEXT_SECTION_LEVELS,
  STEM_TYPE_ALIASES: STEM_TYPE_ALIASES,
  SafeMode: SafeMode,
  SectionLevelStyleRx: SectionLevelStyleRx,
  SetextSectionTitleRx: SetextSectionTitleRx,
  SpaceDelimiterRx: SpaceDelimiterRx,
  SubModifierSniffRx: SubModifierSniffRx,
  TAB: TAB,
  TagDirectiveRx: TagDirectiveRx,
  TrailingDigitsRx: TrailingDigitsRx,
  get USER_HOME () { return USER_HOME; },
  UnorderedListRx: UnorderedListRx,
  UriSniffRx: UriSniffRx,
  VERBATIM_STYLES: VERBATIM_STYLES,
  XmlSanitizeRx: XmlSanitizeRx
});

// ESM conversion of logging.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby's Logger hierarchy (Logger, MemoryLogger, NullLogger) is reimplemented
//     without inheriting from a stdlib Logger class.
//   - Severity levels mirror Ruby's Logger::Severity constants.
//   - Logger.BasicFormatter formats messages as "asciidoctor: SEVERITY: text\n".
//   - Logger.AutoFormattingMessage is an interface for objects that carry both
//     text and source_location; in JS it is a plain object with a custom
//     toString / inspect method attached.
//   - LoggerManager is a module-level singleton object (not a class instance).
//   - The Logging mixin is applied via applyLogging(prototype) which installs
//     `logger` and `messageWithContext` on the target prototype.
//   - In JS there is no $stderr; the default pipe is console.error.

// ── Severity levels (mirrors Ruby Logger::Severity) ──────────────────────────
const Severity = {
  DEBUG:   0,
  INFO:    1,
  WARN:    2,
  ERROR:   3,
  FATAL:   4,
  UNKNOWN: 5,
};

const SEVERITY_LABEL = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'ANY'];
const SEVERITY_LABEL_SUBSTITUTES = { WARN: 'WARNING', FATAL: 'FAILED' };

// Convert a string or nullable severity value to a numeric Severity constant.
function resolveSeverity (severity) {
  if (typeof severity === 'number') return severity
  if (typeof severity === 'string') return Severity[severity.toUpperCase()] ?? Severity.UNKNOWN
  return severity ?? Severity.UNKNOWN
}

// ── Logger ────────────────────────────────────────────────────────────────────

class Logger {
  constructor (opts = {}) {
    this.progname = opts.progname ?? 'asciidoctor';
    this.level = opts.level ?? Severity.WARN;
    this._maxSeverity = null;
    this._formatter = opts.formatter ?? new Logger.BasicFormatter();
    this._pipe = opts.pipe ?? null;  // null → write via _writeln
  }

  // Public getter/setter so custom logger impls can access this.formatter
  get formatter ()  { return this._formatter }
  set formatter (f) { this._formatter = f; }

  get maxSeverity () { return this._maxSeverity }

  // Fluent getters/setters (used by the public API consumed by tests)
  getLevel ()          { return this.level }
  setLevel (n)         { this.level = n; }
  getFormatter ()      { return this._formatter }
  setFormatter (f)     { this._formatter = f; }
  getProgramName ()    { return this.progname }
  setProgramName (n)   { this.progname = n; }
  getMaxSeverity ()    { return this._maxSeverity }

  isDebugEnabled () { return this.level <= Severity.DEBUG }
  isInfoEnabled ()  { return this.level <= Severity.INFO }
  isWarnEnabled ()  { return this.level <= Severity.WARN }
  isErrorEnabled () { return this.level <= Severity.ERROR }
  isFatalEnabled () { return this.level <= Severity.FATAL }

  // Kept for internal compatibility
  isDebug () { return this.level <= Severity.DEBUG }
  isInfo ()  { return this.level <= Severity.INFO }

  add (severity, message = null, progname = null) {
    severity = resolveSeverity(severity);
    if (this._maxSeverity === null || severity > this._maxSeverity) {
      this._maxSeverity = severity;
    }
    if (severity < this.level) return true
    const text = message ?? (typeof progname === 'function' ? progname() : progname);
    const label = SEVERITY_LABEL[severity] ?? 'ANY';
    const line = this._formatter.call(label, null, this.progname, text);
    this._writeln(line);
    return true
  }

  // log() is an alias for add() (Ruby Logger API)
  log (severity, message, progname) { return this.add(severity, message, progname) }

  debug (msg, progname)   { return this.add(Severity.DEBUG,   msg, progname) }
  info (msg, progname)    { return this.add(Severity.INFO,    msg, progname) }
  warn (msg, progname)    { return this.add(Severity.WARN,    msg, progname) }
  error (msg, progname)   { return this.add(Severity.ERROR,   msg, progname) }
  fatal (msg, progname)   { return this.add(Severity.FATAL,   msg, progname) }
  unknown (msg, progname) { return this.add(Severity.UNKNOWN, msg, progname) }

  _writeln (line) {
    if (typeof process !== 'undefined' && process.stderr?.write) {
      process.stderr.write(line);
    } else {
      console.error(line.replace(/\n$/, ''));
    }
  }
}

Logger.BasicFormatter = class {
  call (severity, _time, progname, msg) {
    // severity may be numeric (from newLogger impls) or a string label
    const label = typeof severity === 'number' ? (SEVERITY_LABEL[severity] ?? 'ANY') : severity;
    const substituted = SEVERITY_LABEL_SUBSTITUTES[label] ?? label;
    const text = typeof msg === 'string' ? msg : (msg?.inspect?.() ?? String(msg));
    return `${progname}: ${substituted}: ${text}\n`
  }
};

Logger.AutoFormattingMessage = {
  // Attach auto-formatting to any plain object carrying { text, source_location }.
  // Returns the same object with an inspect() method added.
  attach (obj) {
    obj.inspect = function () {
      const sloc = this.source_location;
      return sloc ? `${sloc}: ${this.text}` : this.text
    };
    obj.toString = obj.inspect;
    return obj
  },
};

// ── LogMessage ────────────────────────────────────────────────────────────────
// Wrapper stored by MemoryLogger; provides getSeverity/getText/getSourceLocation.

class LogMessage {
  constructor (severity, message) {
    this.message = message;
    this.severity = severity; // string label, e.g. 'ERROR'
    // AutoFormattingMessage objects carry { text, source_location }
    if (message !== null && typeof message === 'object' && 'text' in message) {
      this._text = message.text;
      this._sourceLocation = message.source_location ?? null;
    } else {
      this._text = message != null ? String(message) : '';
      this._sourceLocation = null;
    }
  }

  getSeverity ()      { return this.severity }
  getText ()          { return this._text }
  getSourceLocation () { return this._sourceLocation ?? undefined }
}

// ── MemoryLogger ──────────────────────────────────────────────────────────────

class MemoryLogger {
  constructor () {
    // Default level is UNKNOWN (highest) so isDebug() returns false by default,
    // matching Ruby's MemoryLogger (level: UNKNOWN). The add() method stores all
    // messages unconditionally — level is only used by the isDebug() guard.
    this.level = Severity.UNKNOWN;
    this.messages = [];
  }

  static create () { return new MemoryLogger() }

  getMessages () { return this.messages }

  getMaxSeverity () {
    if (this.messages.length === 0) return null
    return Math.max(...this.messages.map(m => Severity[m.getSeverity()] ?? Severity.UNKNOWN))
  }

  add (severity, message = null, progname = null) {
    const sev = resolveSeverity(severity);
    const msg = message ?? (typeof progname === 'function' ? progname() : progname);
    const severityName = SEVERITY_LABEL[sev] ?? 'UNKNOWN';
    this.messages.push(new LogMessage(severityName, msg));
    return true
  }

  debug (msg, pn)   { return this.add(Severity.DEBUG,   msg, pn) }
  info (msg, pn)    { return this.add(Severity.INFO,    msg, pn) }
  warn (msg, pn)    { return this.add(Severity.WARN,    msg, pn) }
  error (msg, pn)   { return this.add(Severity.ERROR,   msg, pn) }
  fatal (msg, pn)   { return this.add(Severity.FATAL,   msg, pn) }
  unknown (msg, pn) { return this.add(Severity.UNKNOWN, msg, pn) }

  log (severity, message, progname) { return this.add(severity, message, progname) }

  isDebug () { return this.level <= Severity.DEBUG }
  isInfo ()  { return this.level <= Severity.INFO }

  // write(s) allows MemoryLogger to be used with Timings.printReport(); messages
  // are stored at INFO level with the trailing newline stripped.
  write (s) { return this.info(s.replace(/\n$/, '')) }

  clear () { this.messages.length = 0; }
  empty () { return this.messages.length === 0 }
}

// ── NullLogger ────────────────────────────────────────────────────────────────

class NullLogger {
  constructor () {
    this.level = Severity.UNKNOWN;
    this._maxSeverity = null;
  }

  static create () { return new NullLogger() }

  get maxSeverity () { return this._maxSeverity }
  getMaxSeverity () { return this._maxSeverity }

  add (severity) {
    const sev = resolveSeverity(severity);
    if (this._maxSeverity === null || sev > this._maxSeverity) this._maxSeverity = sev;
    return true
  }

  log (severity) { return this.add(severity) }

  debug ()   { return this.add(Severity.DEBUG) }
  info ()    { return this.add(Severity.INFO) }
  warn ()    { return this.add(Severity.WARN) }
  error ()   { return this.add(Severity.ERROR) }
  fatal ()   { return this.add(Severity.FATAL) }
  unknown () { return this.add(Severity.UNKNOWN) }
}

// ── LoggerManager ─────────────────────────────────────────────────────────────
// Module-level singleton — the active logger is stored here and can be
// replaced by callers (e.g. the `load` function).

const LoggerManager = (() => {
  let _loggerClass = Logger;
  let _logger = null;

  return {
    get loggerClass () { return _loggerClass },
    set loggerClass (cls) { _loggerClass = cls; },

    get logger () {
      if (!_logger) _logger = new _loggerClass();
      return _logger
    },
    set logger (newLogger) {
      _logger = newLogger ?? new _loggerClass();
    },

    // Public API (mirrors Ruby LoggerManager)
    getLogger () { return this.logger },
    setLogger (newLogger) { this.logger = newLogger; },

    // Create a new formatter whose call() delegates to the provided impl.
    newFormatter (_name, impl) {
      return { call: impl.call.bind(impl) }
    },

    // Create a new Logger instance with custom behaviour supplied via impl.
    //
    // impl - An object that may define:
    //   add(severity, message, progname) - overrides the default add method.
    //     Severity is always delivered as a numeric constant.
    //   postConstruct() - called once after the instance is created; `this`
    //     is the logger instance (use it to open files, etc.).
    newLogger (_name, impl) {
      const inst = new Logger();
      if (impl.add) {
        const customAdd = impl.add;
        inst.add = function (severity, message = null, progname = null) {
          const sev = resolveSeverity(severity);
          if (this._maxSeverity === null || sev > this._maxSeverity) {
            this._maxSeverity = sev;
          }
          return customAdd.call(this, sev, message, progname)
        };
        // Re-bind shorthand methods so they resolve through the custom add
        for (const [meth, sev] of [
          ['debug', Severity.DEBUG], ['info', Severity.INFO], ['warn', Severity.WARN],
          ['error', Severity.ERROR], ['fatal', Severity.FATAL], ['unknown', Severity.UNKNOWN],
        ]) {
          inst[meth] = (msg, pn) => inst.add(sev, msg, pn);
        }
        inst.log = (severity, msg, pn) => inst.add(severity, msg, pn);
      }
      if (impl.postConstruct) impl.postConstruct.call(inst);
      return inst
    },
  }
})();

// ── Logging mixin ─────────────────────────────────────────────────────────────

// Public: Apply the Logging mixin to a class prototype.
//
// proto - The prototype object (e.g. MyClass.prototype) to augment.
//
// The mixin installs:
//   logger               - getter that returns LoggerManager.logger
//   getLogger()          - method alias for the logger getter
//   messageWithContext() - builds an auto-formatting message object
//   createLogMessage()   - alias for messageWithContext (used in extensions)
function applyLogging (proto) {
  Object.defineProperty(proto, 'logger', {
    get () { return LoggerManager.logger },
    configurable: true,
  });

  proto.getLogger = function () { return LoggerManager.logger };

  proto.messageWithContext = function (text, context = {}) {
    return Logger.AutoFormattingMessage.attach({ text, ...context })
  };

  proto.createLogMessage = proto.messageWithContext;
}

// ESM conversion of helpers.rb
// Internal helper functions used by the Asciidoctor parser.
//
// Ruby-to-JavaScript notes:
//   - require_library / require_open_uri have no JS equivalent and are omitted.
//   - resolve_class / class_for_name are Ruby-specific and are omitted.
//   - BOM detection uses the Unicode BOM codepoint U+FEFF instead of raw bytes,
//     since JS strings are always UTF-16 and never carry an encoding tag.
//   - File.basename / File.extname are reimplemented without the Node `path` module
//     so this module works in browser (Opal) and Node environments alike.
//   - mkdir_p delegates to Node's fs.mkdirSync with { recursive: true }.
//   - String#succ (nextval) is implemented for the ASCII alphanumeric subset
//     used by Asciidoctor list-numbering sequences.


// ── BOM ──────────────────────────────────────────────────────────────────────
// Unicode byte-order mark (U+FEFF). In a JS string (already decoded to UTF-16)
// this is the single character that corresponds to all three BOM byte patterns:
//   UTF-8  BOM  0xEF 0xBB 0xBF → U+FEFF
//   UTF-16 LE   0xFF 0xFE      → U+FEFF
//   UTF-16 BE   0xFE 0xFF      → U+FEFF
const BOM = '\uFEFF';

// Internal: Prepare the source data Array for parsing.
//
// Strips a leading BOM from the first element if present, then trims trailing
// whitespace (trimEnd = true) or only the trailing newline (trimEnd = false)
// from every line.
//
// data    - the source data Array to prepare (no null/undefined entries allowed)
// trimEnd - whether to strip all trailing whitespace (true) or only \n (false) (default: true)
//
// Returns a String Array of prepared lines.
// Internal: Trim trailing ASCII whitespace only (not Unicode line separators U+2028/U+2029).
// Ruby's rstrip strips trailing ASCII whitespace (including newlines).
const rstrip = (line) => line.replace(/[ \t\r\n\f\v]+$/, '');

function prepareSourceArray (data, trimEnd = true) {
  if (!data.length) return []
  if (data[0].startsWith(BOM)) data[0] = data[0].slice(1);
  return trimEnd ? data.map(rstrip) : data.map((line) => line.replace(/\n$/, ''))
}

// Internal: Prepare the source data String for parsing.
//
// Strips a leading BOM if present, splits into an array, and trims trailing
// whitespace (trimEnd = true) or only the trailing newline (trimEnd = false)
// from every line.
//
// data    - the source data String to prepare
// trimEnd - whether to strip all trailing whitespace (true) or only \n (false) (default: true)
//
// Returns a String Array of prepared lines.
function prepareSourceString (data, trimEnd = true) {
  if (!data) return []
  if (data.startsWith(BOM)) data = data.slice(1);
  // Ruby's each_line does not produce an empty trailing element when the string
  // ends with \n, but JS split('\n') does. Remove the trailing empty element
  // to match Ruby behaviour.
  if (data.endsWith('\n')) data = data.slice(0, -1);
  const lines = data.split('\n');
  return trimEnd ? lines.map(rstrip) : lines
}

// Internal: Efficiently check whether the specified String resembles a URI.
//
// Uses UriSniffRx to check whether the String begins with a URI prefix (e.g.
// http://). No validation of the URI is performed.
//
// str - the String to check
//
// Returns true if the String is a URI, false if it is not.
function isUriish (str) {
  return str.includes(':') && UriSniffRx.test(str)
}

// Internal: Encode a URI component String for safe inclusion in a URI.
//
// Encodes all characters that are not unreserved per RFC-3986. Specifically,
// encodeURIComponent leaves !, ', (, ), and * unencoded; this function encodes
// those as well so the result matches CGI.escapeURIComponent (Ruby ≥ 3.2) /
// CGI.escape + gsub('+', '%20').
//
// str - the URI component String to encode
//
// Returns the encoded String.
function encodeUriComponent (str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (m) => '%' + m.charCodeAt(0).toString(16))
}

// Internal: Replace spaces with %20 in a URI path.
//
// str - the String to encode
//
// Returns the String with all spaces replaced with %20.
function encodeSpacesInUri (str) {
  return str.includes(' ') ? str.replaceAll(' ', '%20') : str
}

// Public: Remove the file extension from a filename and return the result.
//
// The filename is expected to be a POSIX path. The extension is only stripped
// when no path separator follows the last dot, so paths like
// "dir.with.dots/file" are returned unchanged.
//
// filename - the String file name to process
//
// Examples
//
//   rootname('part1/chapter1.adoc')
//   // => "part1/chapter1"
//
// Returns the String filename with the file extension removed.
function rootname (filename) {
  const lastDotIdx = filename.lastIndexOf('.');
  if (lastDotIdx < 0) return filename
  return filename.indexOf('/', lastDotIdx) >= 0 ? filename : filename.slice(0, lastDotIdx)
}

// Public: Retrieve the basename of a filename, optionally removing the extension.
//
// filename - the String file name to process
// dropExt  - a Boolean flag or an explicit String extension to drop (default: null)
//
// Examples
//
//   basename('images/tiger.png', true)
//   // => "tiger"
//
//   basename('images/tiger.png', '.png')
//   // => "tiger"
//
// Returns the String filename with leading directories removed and, optionally,
// the extension removed.
function basename (filename, dropExt = null) {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  if (!dropExt) return base
  const ext = dropExt === true ? extname(base) : dropExt;
  return (ext && base.endsWith(ext)) ? base.slice(0, -ext.length) : base
}

// Public: Return whether this path has a file extension.
//
// path - the path String to check (expects a POSIX path)
//
// Returns true if the path has a file extension, false otherwise.
function isExtname (path) {
  const lastDotIdx = path.lastIndexOf('.');
  return lastDotIdx >= 0 && path.indexOf('/', lastDotIdx) < 0
}

// Public: Retrieve the file extension of the specified path.
//
// The file extension is the portion of the last path segment starting from
// the last period. Differs from Node's path.extname in that the fallback value
// is configurable.
//
// path     - the path String in which to look for a file extension
// fallback - the fallback String to return if no file extension is present (default: '')
//
// Returns the String file extension (with the leading dot) or fallback.
function extname (path, fallback = '') {
  const lastDotIdx = path.lastIndexOf('.');
  if (lastDotIdx < 0) return fallback
  // treat both '/' and '\\' as path separators (Windows support)
  if (path.indexOf('/', lastDotIdx) >= 0 || path.indexOf('\\', lastDotIdx) >= 0) return fallback
  return path.slice(lastDotIdx)
}

// Internal: Make a directory, creating all missing parent directories.
//
// dir - the String path of the directory to create
//
// Returns undefined. Throws if the path cannot be created.
// Public: Async-aware string replacement using matchAll.
// The replacer may return a string or a Promise<string>.
// The regex is treated as global regardless of its flags.
//
// str      - The String to perform replacements on.
// regex    - The RegExp pattern to match.
// replacer - An async function receiving the same arguments as String#replace callbacks.
//
// Returns a Promise<String> with all matches replaced.
async function asyncReplace (str, regex, replacer) {
  const gRegex = regex.flags.includes('g')
    ? regex
    : new RegExp(regex.source, regex.flags + 'g');
  const matches = [...str.matchAll(gRegex)];
  if (matches.length === 0) return str
  const parts = [];
  let lastIndex = 0;
  for (const match of matches) {
    parts.push(str.slice(lastIndex, match.index));
    // Process replacements sequentially so state mutations (e.g. footnote registration)
    // are visible to subsequent replacements in the same string.
    parts.push(await replacer(...match, match.index, str));
    lastIndex = match.index + match[0].length;
  }
  parts.push(str.slice(lastIndex));
  return parts.join('')
}

// ── Roman numeral helpers ─────────────────────────────────────────────────────

const ROMAN_NUMERALS_WITH_REDUCERS = [
  ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
  ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
  ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1],
];

const ROMAN_NUMERALS = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

// Internal: Convert an integer to a Roman numeral.
//
// val - the integer value to convert
//
// Returns the String Roman numeral.
function intToRoman (val) {
  let result = '';
  for (const [l, i] of ROMAN_NUMERALS_WITH_REDUCERS) {
    const repeat = Math.floor(val / i);
    val %= i;
    result += l.repeat(repeat);
  }
  return result
}

// Internal: Convert an uppercase Roman numeral to an integer.
//
// val - the String Roman numeral in uppercase to convert
//
// Returns the integer value.
function romanToInt (val) {
  const valmap = [...val].map((c) => ROMAN_NUMERALS[c]);
  let result = 0;
  for (let idx = 0; idx < valmap.length; idx++) {
    const v = valmap[idx];
    const succ = valmap[idx + 1];
    result += (succ && succ > v) ? -v : v;
  }
  return result
}

// Internal: Get the next value in a sequence.
//
// Handles integer sequences (numeric increment) and alphabetic sequences
// (ASCII letter increment with carry, matching Ruby's String#succ for the
// alphanumeric subset used by Asciidoctor list labels).
//
// current - the value to increment as a String or Number
//
// Returns the next value in the sequence.
function nextval (current) {
  if (typeof current === 'number') return current + 1
  const intval = parseInt(current, 10);
  if (String(intval) === String(current)) return intval + 1
  // Mirrors Ruby's String#succ for single- and multi-character strings.
  // Strategy: find the rightmost ASCII-alphanumeric character and increment it
  // with carry.  If NO alphanumeric character exists, increment the rightmost
  // character's Unicode code point instead.
  const chars = [...current];  // split by Unicode code point (handles surrogate pairs)
  let hasAlnum = false;
  for (let i = chars.length - 1; i >= 0; i--) {
    const code = chars[i].codePointAt(0);
    const isLower = code >= 97 && code <= 122;
    const isUpper = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (!isLower && !isUpper && !isDigit) continue
    hasAlnum = true;
    const atEnd = (isLower && code === 122) || (isUpper && code === 90) || (isDigit && code === 57);
    if (!atEnd) {
      chars[i] = String.fromCodePoint(code + 1);
      return chars.join('')
    }
    // Carry: wrap this char and continue to the next alphanumeric to the left.
    chars[i] = isLower ? 'a' : isUpper ? 'A' : '0';
    // Find next alphanumeric to carry into.
    let carried = false;
    for (let j = i - 1; j >= 0; j--) {
      const c2 = chars[j].codePointAt(0);
      const l2 = c2 >= 97 && c2 <= 122;
      const u2 = c2 >= 65 && c2 <= 90;
      const d2 = c2 >= 48 && c2 <= 57;
      if (!l2 && !u2 && !d2) continue
      const end2 = (l2 && c2 === 122) || (u2 && c2 === 90) || (d2 && c2 === 57);
      if (!end2) {
        chars[j] = String.fromCodePoint(c2 + 1);
        carried = true;
        break
      }
      chars[j] = l2 ? 'a' : u2 ? 'A' : '0';
    }
    if (!carried) {
      // All alphanumeric characters wrapped — prepend carry character.
      const carry = isLower ? 'a' : isUpper ? 'A' : '1';
      return carry + chars.join('')
    }
    return chars.join('')
  }
  if (!hasAlnum) {
    // No alphanumeric chars: increment the rightmost character's code point.
    const last = chars.length - 1;
    const code = chars[last].codePointAt(0);
    chars[last] = String.fromCodePoint(code + 1);
    return chars.join('')
  }
  return current
}

// ESM conversion of load.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby module methods on Asciidoctor → named exports load() and loadFile().
//   - Ruby File === input branch → Node.js fs.createReadStream / fs.readFileSync
//     adapted to check for an object with a .read() method (duck-typing).
//   - Ruby File.absolute_path / File.dirname / Helpers.basename / Helpers.extname
//     → implemented using Node's node:path and the helpers.js module.
//   - The timings option is passed through but its start/record calls are no-ops
//     unless a real Timings object is supplied (interface: { start(label), record(label) }).
//   - LoggerManager from logging.js is used to honour the :logger option.
//   - SpaceDelimiterRx / EscapedSpaceRx / NULL are imported from rx.js / constants.js
//     for string-form attributes parsing (mirrors the Ruby gsub/split dance).
//   - Document is lazily imported to avoid circular-dependency issues at module load.


// ── load ──────────────────────────────────────────────────────────────────────

// Public: Parse the AsciiDoc source input into a Document.
//
// Accepts input as a Node.js Readable stream (or any object with a read()
// method), a String, or a String Array. If the input is a file descriptor
// object produced by openFile() / Node's fs.openSync(), pass a plain object
// with { path, read() } instead; the function sets docfile/docdir/docname
// attributes automatically.
//
// input   - the AsciiDoc source as a Buffer, String, String Array, or
//           a file-like object with { path: String, read(): String, mtime? }.
// options - a plain object of options to control processing (default: {}).
//           See Document for the full list of recognised keys.
//           Notable keys:
//             :attributes - String, Array, or Object of document attributes
//             :parse      - set to false to skip parsing after Document creation
//             :logger     - Logger instance to use for this call
//             :timings    - Timings object with start()/record() interface
//
// Returns a Promise that resolves to the Document.
async function load (input, options = {}) {
  // Shallow-copy options so we don't mutate the caller's object.
  options = Object.assign({}, options);

  const timings = options.timings ?? null;
  if (timings) timings.start('read');

  // ── Logger override ───────────────────────────────────────────────────────
  if ('logger' in options) {
    const logger = options.logger;
    if (logger !== LoggerManager.logger) {
      LoggerManager.logger = logger ?? new NullLogger();
    }
  }

  // ── Attributes normalisation ──────────────────────────────────────────────
  let attrs = options.attributes;
  if (!attrs) {
    attrs = {};
  } else if (typeof attrs === 'string') {
    // Condense non-escaped whitespace runs to NULL, unescape escaped spaces, split on NULL.
    attrs = _parseAttributeString(attrs);
  } else if (Array.isArray(attrs)) {
    attrs = _parseAttributeArray(attrs);
  } else if (typeof attrs === 'object') {
    attrs = Object.assign({}, attrs);
  } else {
    throw new TypeError(`illegal type for attributes option: ${typeof attrs}`)
  }

  // ── Input reading ─────────────────────────────────────────────────────────
  let source;
  if (input && typeof input === 'object' && typeof input.read === 'function') {
    // Duck-typed file-like object: { path?, mtime?, read() }
    if (input.path) {
      // Treat it like a File object: resolve path, set docfile/docdir/docname.
      const nodePath = await _requirePath();
      const inputPath = nodePath.resolve(input.path);
      if (input.mtime) options.input_mtime = input.mtime;
      attrs.docfile = inputPath;
      attrs.docdir  = nodePath.dirname(inputPath);
      const docfilesuffix = extname(inputPath);
      attrs.docfilesuffix = docfilesuffix;
      attrs.docname = basename(inputPath, docfilesuffix);
    }
    source = await _readStream(input);
  } else if (typeof input === 'object' && input?.constructor?.name === 'Buffer') {
    source = input.toString('utf8');
  } else if (typeof input === 'string') {
    source = input;
  } else if (Array.isArray(input)) {
    source = input.slice();
  } else if (input) {
    throw new TypeError(`unsupported input type: ${typeof input}`)
  }

  if (timings) {
    timings.record('read');
    timings.start('parse');
  }

  options.attributes = attrs;

  // ── Document construction + optional parse ────────────────────────────────
  let doc;
  try {
    // Pre-load circular deps into the _deps cache before constructing Document.
    // Also pre-warm the converter cache so _createConverter can run synchronously.
    const [{ Document, _deps }, readerMod, parserMod, extensionsMod, { Converter }, { BACKEND_ALIASES }] = await Promise.all([
      Promise.resolve().then(function () { return document; }),
      Promise.resolve().then(function () { return reader; }),
      Promise.resolve().then(function () { return parser; }),
      Promise.resolve().then(function () { return extensions; }),
      Promise.resolve().then(function () { return converter; }),
      Promise.resolve().then(function () { return constants; }),
      Promise.resolve().then(function () { return highlightjs; }),
    ]);
    _deps['reader.js'] = readerMod;
    _deps['parser.js'] = parserMod;
    _deps['extensions.js'] = extensionsMod;
    let backend = String(attrs.backend || options.backend || 'html5');
    // Strip soft-set modifier (@) and value-based soft-set (ending with @)
    if (backend.endsWith('@')) backend = backend.slice(0, -1);
    if (backend.startsWith('xhtml')) backend = `html${backend.slice(5)}`;  // xhtml5 → html5
    backend = BACKEND_ALIASES[backend] ?? backend;
    await Converter.create(backend, {});
    if (options.parse !== false) {
      doc = await Document.create(source, options);
    } else {
      doc = new Document(source, options);
    }
  } catch (e) {
    const docfile = attrs.docfile || '<stdin>';
    const context = `asciidoctor: FAILED: ${docfile}: Failed to load AsciiDoc document`;
    let wrapped;
    try {
      wrapped = new Error(`${context} - ${e.message}`);
      wrapped.stack = e.stack;
      wrapped.cause = e;
    } catch {
      wrapped = e;
    }
    throw wrapped
  }

  if (timings) timings.record('parse');
  return doc
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Internal: Parse a whitespace-delimited attribute string into a plain object.
//
// Mirrors the Ruby idiom:
//   attrs.gsub(SpaceDelimiterRx, '\1' + NULL).gsub(EscapedSpaceRx, '\1').split(NULL)
//
// Returns a plain object { key => value }.
function _parseAttributeString (str) {
  const condensed = str
    .replace(SpaceDelimiterRx, '$1' + NULL)
    .replace(EscapedSpaceRx, '$1');
  const result = {};
  for (const entry of condensed.split(NULL)) {
    if (!entry) continue
    const eqIdx = entry.indexOf('=');
    if (eqIdx < 0) {
      result[entry] = '';
    } else {
      result[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
  }
  return result
}

// Internal: Parse an array of "key=value" entries into a plain object.
//
// Returns a plain object { key => value }.
function _parseAttributeArray (arr) {
  const result = {};
  for (const entry of arr) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx < 0) {
      result[entry] = '';
    } else {
      result[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
  }
  return result
}

// Internal: Read all data from an object that has a .read() method.
// Supports both synchronous (returns string) and async (returns Promise) variants.
//
// Returns a Promise that resolves to a String.
async function _readStream (readable) {
  const data = readable.read();
  return (data instanceof Promise) ? data : Promise.resolve(data ?? '')
}

// Internal: Lazily import node:path to avoid issues in browser / Opal environments.
//
// Returns a Promise that resolves to the node:path module.
async function _requirePath () {
  return import('node:path')
}

// ESM conversion of timings.rb
//
// Ruby-to-JavaScript notes:
//   - Process.clock_gettime(CLOCK_MONOTONIC) → performance.now() (ms, not s).
//     All stored values are in milliseconds.
//   - print_report writes to a stream; in JS the default is console.log.
//     Pass a { write(line) } object to customise the output destination.

class Timings {
  static create () { return new Timings() }

  constructor () {
    this._log = {};
    this._timers = {};
  }

  start (key) {
    this._timers[key] = this._now();
  }

  record (key) {
    this._log[key] = this._now() - (this._timers[key] ?? 0);
    delete this._timers[key];
  }

  time (...keys) {
    const total = keys.reduce((sum, key) => sum + (this._log[key] || 0), 0);
    return total > 0 ? total : null
  }

  read ()           { return this.time('read') }
  parse ()          { return this.time('parse') }
  readParse ()      { return this.time('read', 'parse') }
  convert ()        { return this.time('convert') }
  readParseConvert () { return this.time('read', 'parse', 'convert') }
  write ()          { return this.time('write') }
  total ()          { return this.time('read', 'parse', 'convert', 'write') }

  // Public: Print a summary report.
  //
  // out     - An object with a write(line) or log(line) method (default: console).
  // subject - Optional String label for the input file.
  printReport (out = console, subject = null) {
    const writeln = typeof out.write === 'function'
      ? (s) => out.write(s + '\n')
      : (s) => out.log(s);
    if (subject) writeln(`Input file: ${subject}`);
    writeln(`  Time to read and parse source: ${(this.readParse() ?? 0).toFixed(5)}`);
    writeln(`  Time to convert document: ${(this.convert() ?? 0).toFixed(5)}`);
    writeln(`  Total time (read, parse and convert): ${(this.readParseConvert() ?? 0).toFixed(5)}`);
  }

  _now () {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  }
}

// ESM conversion of abstract_node.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby symbols (:document, :context) are represented as plain strings.
//   - attr_reader / attr_accessor are implemented as plain instance properties;
//     cases where the setter has side effects use JS get/set pairs.
//   - Ruby methods ending in ? are renamed: attr? → hasAttr, block? → isBlock,
//     inline? → isInline, role? → hasRoleAttr, has_role? → hasRole,
//     option? → hasOption, reftext? → hasReftext.
//   - Ruby methods ending in = that have side effects use JS set accessors:
//     parent= → set parent(), role= → set role().
//   - snake_case method/property names are converted to camelCase:
//     node_name → nodeName, set_attr → setAttr, etc.
//   - The Logging mixin (logger getter) is provided as a default on AbstractNode;
//     it falls back to the document's logger or the global console.
//   - The Substitutors mixin is applied via Object.assign(AbstractNode.prototype, Substitutors)
//     after both modules are loaded (see the bottom of substitutors.js).
//   - File I/O in generateDataUri / readAsset uses node:fs/promises async APIs.
//     When the resolved path is an HTTP URI (browser: docdir is a URL), readAsset
//     delegates to browser/asset.js (Fetch API) instead of using the filesystem.
//   - generateDataUriFromUri and readContents use the Fetch API and are async;
//     imageUri and readContents must be awaited when the data-uri + allow-uri-read
//     combination is active.
//   - Ruby's Set is represented as a JavaScript Set.


// ── Node.js fs (lazy, optional) ───────────────────────────────────────────────
// Loaded on first use in Node.js; silently absent in browser/WebWorker environments.
let _fsp$1;          // undefined = not tried, null = unavailable, object = available
let _fsConstants$1;  // node:fs constants (R_OK etc.) — not on node:fs/promises

async function _requireFsp$1() {
  if (_fsp$1 !== undefined) return
  try {
    _fsp$1 = await import('node:fs/promises');
    _fsConstants$1 = (await import('node:fs')).constants;
  } catch {
    _fsp$1 = null;
  }
}

async function isReadable(path) {
  await _requireFsp$1();
  if (!_fsp$1) return false
  try {
    await _fsp$1.access(path, _fsConstants$1.R_OK);
    return true
  } catch {
    return false
  }
}

/**
 * An abstract base class that provides state and methods for managing a node of AsciiDoc content.
 * The state and methods on this class are common to all content segments in an AsciiDoc document.
 */
class AbstractNode {
  constructor(parent, context, opts = {}) {
    // document is a special case – should refer to itself
    if (context === 'document') {
      this.document = this;
    } else if (parent) {
      this._parent = parent;
      this.document = parent.document;
    }
    this.context = context;
    this.nodeName = String(context);
    this.id = null;
    // NOTE the value of the attributes option may be undefined on an Inline node
    const attrs = opts.attributes;
    this.attributes = attrs ? { ...attrs } : {};
    this.passthroughs = [];
  }

  /**
   * Get/Set the parent of this node.
   * The setter also updates the document reference.
   */
  get parent() {
    return this._parent
  }

  set parent(parent) {
    this._parent = parent;
    this.document = parent.document;
  }

  /**
   * Get the space-separated role string for this node.
   * Set accepts a single role name, a space-separated string, or an Array.
   */
  get role() {
    return this.attributes.role
  }

  set role(names) {
    this.attributes.role = Array.isArray(names) ? names.join(' ') : names;
  }

  /**
   * Get the role names for this node as an Array.
   */
  get roles() {
    const val = this.attributes.role;
    return val ? val.split(' ') : []
  }

  /**
   * Retrieve the space-separated String role for this node.
   *
   * @returns {string|undefined} the role as a space-separated String.
   */
  getRole() {
    return this.role
  }

  /**
   * Set the value of the role attribute on this node.
   *
   * Accepts a single role name, a space-separated String, an Array, or spread arguments.
   *
   * @param {...string|string[]} names - A single role name, a space-separated String, an Array,
   *   or multiple role names as spread arguments.
   * @returns {string} the value of the role attribute.
   */
  setRole(...names) {
    this.role = names.length === 1 ? names[0] : names;
    return this.attributes.role
  }

  /**
   * Retrieve the String role names for this node as an Array.
   *
   * @returns {string[]} the role names as a String Array, empty if the role attribute is absent.
   */
  getRoles() {
    return this.roles
  }

  /**
   * @returns true if this AbstractNode is an instance of Block.
   * @throws {Error} Subclasses must override this method.
   */
  isBlock() {
    throw new Error('NotImplementedError')
  }

  /**
   * @returns true if this AbstractNode is an instance of Inline.
   * @throws {Error} Subclasses must override this method.
   */
  isInline() {
    throw new Error('NotImplementedError')
  }

  /**
   * Get the converter instance being used to convert the current Document.
   */
  get converter() {
    return this.document.converter
  }

  /**
   * Get the String name of this node.
   *
   * @returns {string} the node name.
   */
  getNodeName() {
    return this.nodeName
  }

  /**
   * Get the String id for this node.
   *
   * @returns {string|undefined} the id, or undefined if not set.
   */
  getId() {
    return this.id ?? undefined
  }

  /**
   * Set the String id for this node.
   *
   * @param {string} id - The String id to assign.
   */
  setId(id) {
    this.id = id;
  }

  /**
   * Get the context name for this node.
   *
   * @returns {string} the context name.
   */
  getContext() {
    return this.context
  }

  /**
   * Get the {Converter} instance being used to convert the current {Document}.
   *
   * @returns {object} the converter instance.
   */
  getConverter() {
    return this.converter
  }

  /**
   * Get the value of the specified attribute.
   *
   * Looks for the attribute on this node first. If not found and fallbackName is
   * set (default: same as name), and this node is not the Document node, look for
   * that attribute on the Document node. Otherwise return defaultValue.
   *
   * @param {string} name - The String or Symbol name of the attribute to resolve.
   * @param {*} [defaultValue=null] - The value to return if the attribute is not found.
   * @param {string|boolean|null} [fallbackName=null] - The String/Symbol/true to resolve on the
   *   Document when the attribute is absent on this node. When true, uses name.
   * @returns {*} the attribute value or defaultValue.
   */
  attr(name, defaultValue = null, fallbackName = null) {
    const key = String(name);
    const val = this.attributes[key];
    if (val != null) return val
    if (fallbackName && this._parent) {
      const fallbackKey = String(fallbackName === true ? name : fallbackName);
      const docVal = this.document.attributes[fallbackKey];
      if (docVal != null) return docVal
    }
    return defaultValue
  }

  /**
   * Check if the specified attribute is defined, optionally comparing against an expected value.
   *
   * @param {string} name - The String or Symbol name of the attribute to resolve.
   * @param {*} [expectedValue=null] - The expected value of the attribute.
   *   When truthy, the method returns whether the resolved value matches.
   * @param {string|boolean|null} [fallbackName=null] - The String/Symbol/true to resolve on the
   *   Document when the attribute is absent on this node.
   * @returns {boolean}
   */
  hasAttr(name, expectedValue = null, fallbackName = null) {
    const key = String(name);
    if (expectedValue) {
      const val = this.attributes[key] ??
        (fallbackName && this._parent
          ? this.document.attributes[String(fallbackName === true ? name : fallbackName)]
          : null);
      return expectedValue === val
    }
    return key in this.attributes ||
      !!(fallbackName && this._parent &&
        String(fallbackName === true ? name : fallbackName) in this.document.attributes)
  }

  /**
   * Get the value of the specified attribute.
   *
   * If the attribute is not found on this node, fallbackName is set, and this node is not
   * the Document node, get the value of the specified attribute from the Document node.
   *
   * @param {string} name - The String name of the attribute to resolve.
   * @param {*} [defaultValue=undefined] - The value to return if the attribute is not found.
   * @param {string|boolean} [inherit=false] - The String of the attribute to resolve on the
   *   Document if the attribute is not found on this node (default: same as name).
   * @returns {*} the attribute value, or defaultValue if the attribute is not found.
   */
  getAttribute(name, defaultValue = undefined, inherit = false) {
    const val = this.attr(name, null, inherit || null);
    return val != null ? val : defaultValue
  }

  /**
   * Check whether the specified attribute is present on this node.
   * Alias for {@link hasAttr} for API compatibility.
   *
   * @param {string} name - The String name of the attribute to resolve.
   * @param {*} [expectedValue=null] - The expected value of the attribute.
   * @param {string|boolean|null} [fallbackName=null] - The fallback attribute name on the Document.
   * @returns {boolean}
   */
  hasAttribute(name, expectedValue = null, fallbackName = null) {
    return this.hasAttr(name, expectedValue, fallbackName)
  }

  /**
   * Set the value of the specified attribute on this node.
   *
   * @param {string} name - The String attribute name to assign.
   * @param {*} [value=''] - The value to assign to the attribute.
   * @param {boolean} [overwrite=true] - Whether to overwrite an existing attribute.
   * @returns {boolean} true if set, false if blocked.
   */
  setAttribute(name, value = '', overwrite = true) {
    return this.setAttr(name, value, overwrite)
  }

  /**
   * Check if the specified attribute is defined with an optional value match.
   *
   * Equivalent to {@link getAttribute}, but returns a Boolean rather than the value.
   *
   * @param {string} name - The String attribute name.
   * @param {*} [expectedValue=null] - The expected value; when provided, also checks the value.
   * @returns {boolean}
   */
  isAttribute(name, expectedValue = null) {
    if (expectedValue != null) return this.getAttribute(name) === expectedValue
    return name in this.attributes
  }

  /**
   * Remove the attribute from this node.
   *
   * @param {string} name - The String attribute name to remove.
   * @returns {*} the previous value, or undefined if not present.
   */
  removeAttribute(name) {
    return this.removeAttr(name)
  }

  /**
   * Get the attributes hash for this node.
   *
   * @returns {Object} a plain Object of attributes.
   */
  getAttributes() {
    return this.attributes
  }

  /**
   * Get the document to which this node belongs.
   *
   * @returns {Document} the Document.
   */
  getDocument() {
    return this.document
  }

  /**
   * Get the parent node of this node.
   *
   * @returns {AbstractNode|undefined} the parent AbstractNode, or undefined for the root document.
   */
  getParent() {
    return this.parent
  }

  /**
   * Get the icon URI for the named icon.
   *
   * @param {string} name - The String icon name.
   * @returns {Promise<string>} a Promise resolving to a String URI.
   */
  getIconUri(name) {
    return this.iconUri(name)
  }

  /**
   * Get the media URI for the target.
   *
   * @param {string} target - The String target path or URL.
   * @param {string} [assetDirKey='imagesdir'] - The String asset directory attribute key.
   * @returns {string} a String URI.
   */
  getMediaUri(target, assetDirKey = 'imagesdir') {
    return this.mediaUri(target, assetDirKey)
  }

  /**
   * Get the image URI for the target image.
   *
   * @param {string} targetImage - The String target image path or URL.
   * @param {string|null} [assetDirKey=null] - The String asset directory attribute key.
   * @returns {Promise<string>} a Promise resolving to a String URI.
   */
  getImageUri(targetImage, assetDirKey = null) {
    return this.imageUri(targetImage, assetDirKey)
  }

  /**
   * Assign the value to the attribute name for the current node.
   *
   * @param {string} name - The String attribute name to assign.
   * @param {*} [value=''] - The value to assign to the attribute.
   * @param {boolean} [overwrite=true] - Whether to overwrite an existing attribute.
   * @returns {boolean} true if set, false if blocked.
   */
  setAttr(name, value = '', overwrite = true) {
    if (overwrite === false && name in this.attributes) return false
    this.attributes[name] = value;
    return true
  }

  /**
   * Remove the attribute from the current node.
   *
   * @param {string} name - The String attribute name to remove.
   * @returns {*} the previous value, or undefined if the attribute was not present.
   */
  removeAttr(name) {
    const val = this.attributes[name];
    delete this.attributes[name];
    return val
  }

  /**
   * Retrieve the value of the named attribute.
   * Alias for {@link attr} to match the public Ruby API.
   *
   * @param {string} name - The String attribute name.
   * @param {*} [defaultValue=null] - The value to return if the attribute is not found.
   * @param {string|boolean} [inherit=false] - The fallback attribute name on the Document.
   * @returns {*} the attribute value or defaultValue.
   */
  getAttr(name, defaultValue = null, inherit = false) {
    return this.attr(name, defaultValue, inherit || null)
  }

  /**
   * Check if the specified option attribute is enabled on this node.
   * This method checks whether the `<name>-option` attribute is set.
   *
   * @param {string} name - The String or Symbol name of the option.
   * @returns {boolean} true if the option is enabled, false otherwise.
   */
  hasOption(name) {
    return `${name}-option` in this.attributes
  }

  /**
   * Set the specified option on this node by setting the `<name>-option` attribute.
   *
   * @param {string} name - The String name of the option.
   */
  setOption(name) {
    this.attributes[`${name}-option`] = '';
  }

  /**
   * Retrieve the Set of option names that are enabled on this node.
   *
   * @returns {Set<string>} a Set of option name strings.
   */
  enabledOptions() {
    const result = new Set();
    for (const k of Object.keys(this.attributes)) {
      if (k.endsWith('-option')) result.add(k.slice(0, k.length - 7));
    }
    return result
  }

  /**
   * Update the attributes of this node with the new values.
   *
   * @param {Object} newAttributes - A plain object of additional attributes to assign.
   * @returns {Object} the updated attributes object on this node.
   */
  updateAttributes(newAttributes) {
    return Object.assign(this.attributes, newAttributes)
  }

  /**
   * Check if the role attribute is set and, optionally, matches expectedValue.
   *
   * @param {string|null} [expectedValue=null] - The expected String value of the role.
   * @returns {boolean}
   */
  hasRoleAttr(expectedValue = null) {
    if (expectedValue != null) return expectedValue === this.attributes.role
    return 'role' in this.attributes
  }

  /**
   * Check if the specified role name is present in this node's role list.
   *
   * @param {string} name - The String role name to find.
   * @returns {boolean}
   */
  hasRole(name) {
    const val = this.attributes.role;
    return val ? ` ${val} `.includes(` ${name} `) : false
  }

  /**
   * Add the given role directly to this node.
   *
   * @param {string} name - The String role name to add.
   * @returns {boolean} true if the role was added, false if it was already present.
   */
  addRole(name) {
    const val = this.attributes.role;
    if (val) {
      if (` ${val} `.includes(` ${name} `)) return false
      this.attributes.role = `${val} ${name}`;
      return true
    }
    this.attributes.role = name;
    return true
  }

  /**
   * Remove the given role directly from this node.
   *
   * @param {string} name - The String role name to remove.
   * @returns {boolean} true if the role was removed, false if it was not present.
   */
  removeRole(name) {
    const val = this.attributes.role;
    if (!val) return false
    const roles = val.split(' ');
    const idx = roles.indexOf(name);
    if (idx < 0) return false
    roles.splice(idx, 1);
    if (roles.length === 0) {
      delete this.attributes.role;
    } else {
      this.attributes.role = roles.join(' ');
    }
    return true
  }

  /**
   * Get the value of the reftext attribute with substitutions applied.
   * The result is pre-computed during Document.parse() via {@link precomputeReftext}.
   * Falls back to the raw reftext attribute if precomputeReftext() has not been called yet.
   *
   * @returns {string|null} the String reftext or null if not set.
   */
  get reftext() {
    if (this._convertedReftext !== undefined) return this._convertedReftext
    const val = this.attributes.reftext;
    return val ?? null
  }

  /**
   * Pre-compute the reftext with substitutions applied asynchronously.
   * Called during Document.parse() so the synchronous getter works during conversion.
   *
   * @returns {Promise<void>}
   */
  async precomputeReftext() {
    const val = this.attributes.reftext;
    this._convertedReftext = val != null ? await this.applyReftextSubs(val) : null;
  }

  /**
   * Check if the reftext attribute is defined.
   *
   * @returns {boolean}
   */
  hasReftext() {
    return 'reftext' in this.attributes
  }

  /**
   * Get the value of the reftext attribute with substitutions applied.
   *
   * @returns {string|undefined} the reftext value, or undefined if not set.
   */
  getReftext() {
    return this.reftext ?? undefined
  }

  /**
   * Construct a reference or data URI to an icon image for the given name.
   *
   * If the 'icon' attribute is set on this node the name is ignored and the
   * attribute value is used as the target path. Otherwise the icon path is built
   * from 'iconsdir', the name, and 'icontype' (default: 'png').
   *
   * @param {string} name - The String name of the icon.
   * @returns {Promise<string>} a Promise resolving to a String reference or data URI for the icon image.
   */
  async iconUri(name) {
    let icon;
    if (this.hasAttr('icon')) {
      icon = this.attr('icon');
      if (!isExtname(icon)) icon = `${icon}.${this.document.attr('icontype', 'png')}`;
    } else {
      icon = `${name}.${this.document.attr('icontype', 'png')}`;
    }
    return this.imageUri(icon, 'iconsdir')
  }

  /**
   * Construct a URI reference or data URI to the target image.
   *
   * If the target image is already a URI it is left untouched (unless data-uri
   * conversion is requested). The image is resolved relative to the directory
   * named by assetDirKey. When data-uri is enabled and the safe level permits,
   * the image is embedded as a Base64 data URI.
   *
   * NOTE: When the document has both 'data-uri' and 'allow-uri-read' enabled
   * and the resolved image URL is a remote URI, this method returns a Promise
   * rather than a String. Await the result when that combination may be active.
   *
   * @param {string} targetImage - A String path to the target image.
   * @param {string} [assetDirKey='imagesdir'] - The String attribute key for the image directory.
   * @returns {Promise<string>} a Promise resolving to a String reference or data URI.
   */
  async imageUri (targetImage, assetDirKey = 'imagesdir') {
    const doc = this.document;
    if (doc.safe < SafeMode.SECURE && doc.hasAttr('data-uri')) {
      let imagesBase;
      if (
        (isUriish(targetImage) && (targetImage = encodeSpacesInUri(targetImage))) ||
        (assetDirKey &&
          (imagesBase = this.attr(assetDirKey, null, true)) &&
          isUriish(imagesBase) &&
          (targetImage = this.normalizeWebPath(targetImage, imagesBase, false)))
      ) {
        return doc.hasAttr('allow-uri-read')
          ? this.generateDataUriFromUri(targetImage, doc.hasAttr('cache-uri'))
          : targetImage
      }
      return this.generateDataUri(targetImage, assetDirKey)
    }
    return this.normalizeWebPath(targetImage, assetDirKey ? this.attr(assetDirKey, null, true) : null)
  }

  /**
   * Construct a URI reference to the target media.
   *
   * @param {string} target - A String reference to the target media.
   * @param {string} [assetDirKey='imagesdir'] - The String attribute key for the media directory.
   * @returns {string} a String reference for the target media.
   */
  mediaUri(target, assetDirKey = 'imagesdir') {
    return this.normalizeWebPath(target, assetDirKey ? this.attr(assetDirKey, null, true) : null)
  }

  /**
   * Generate a data URI that embeds the image at the given local path.
   *
   * The image path is cleaned to prevent access outside the jail when the
   * document safe level is SafeMode.SAFE or higher. The image data is read
   * and Base64-encoded. In non-Node environments this method returns an empty
   * data URI with a warning.
   *
   * @param {string} targetImage - A String path to the target image.
   * @param {string|null} [assetDirKey=null] - The String attribute key for the image directory.
   * @returns {Promise<string>} a Promise resolving to a String data URI.
   */
  async generateDataUri(targetImage, assetDirKey = null) {
    const ext = extname(targetImage, null);
    const mimetype = ext
      ? (ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`)
      : 'application/octet-stream';
    const imagePath = assetDirKey
      ? this.normalizeSystemPath(targetImage, this.attr(assetDirKey, null, true), null, { targetName: 'image' })
      : this.normalizeSystemPath(targetImage);
    if (isUriish(imagePath)) {
      return await this.generateDataUriFromUri(imagePath, this.document.hasAttr('cache-uri'));
    }
    if (await isReadable(imagePath)) {
      const data = await _fsp$1.readFile(imagePath);
      return `data:${mimetype};base64,${data.toString('base64')}`
    }
    this.logger.warn(`image to embed not found or not readable: ${imagePath}`);
    return `data:${mimetype};base64,`
  }

  /**
   * Read the image data from the specified URI and generate a data URI.
   *
   * The image data is fetched and Base64-encoded. The MIME type is taken from
   * the Content-Type response header.
   *
   * NOTE: This method is async in JS (the Fetch API is async). When called from
   * imageUri, the caller must await the returned Promise.
   *
   * @param {string} imageUri - The URI from which to read the image data (http/https/ftp).
   * @param {boolean} [cacheUri=false] - A Boolean to control caching (not yet supported in JS).
   * @returns {Promise<string>} a Promise resolving to a String data URI.
   */
  async generateDataUriFromUri(imageUri, cacheUri = false) { // eslint-disable-line no-unused-vars
    try {
      const response = await fetch(imageUri);
      if (response.ok) {
        const mimetype = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
        const buffer = await response.arrayBuffer();
        const base64 = btoa(Array.from(new Uint8Array(buffer), (b) => String.fromCharCode(b)).join(''));
        return `data:${mimetype};base64,${base64}`
      } else {
        const ext = extname(imageUri, null);
        const mimetype =  ext
          ? (ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`)
          : 'application/octet-stream';
        this.logger.warn(`image to embed not found or not readable: ${imageUri}`);
        return `data:${mimetype};base64,`
      }
    } catch {
      this.logger.warn(`could not retrieve image data from URI: ${imageUri}`);
      return imageUri
    }
  }

  /**
   * Normalize the asset file or directory to a concrete and rinsed path.
   *
   * Delegates to {@link normalizeSystemPath} with start set to document.baseDir.
   *
   * @param {string} assetRef - The String asset reference to normalize.
   * @param {string} [assetName='path'] - The String label for the asset used in messages.
   * @param {boolean} [autocorrect=true] - A Boolean indicating whether to recover from an illegal path.
   * @returns {string} the normalized String path.
   */
  normalizeAssetPath(assetRef, assetName = 'path', autocorrect = true) {
    return this.normalizeSystemPath(assetRef, this.document.baseDir, null, {
      targetName: assetName,
      recover: autocorrect
    })
  }

  /**
   * Resolve and normalize a secure path from the target and start paths.
   *
   * Prevents resolving a path outside the jail (defaulting to document.baseDir)
   * when the document safe level is SafeMode.SAFE or higher.
   *
   * @param {string} target - The String target path.
   * @param {string|null} [start=null] - The String start (parent) path.
   * @param {string|null} [jail=null] - The String jail path.
   * @param {Object} [opts={}] - A plain object of options:
   *   - `recover` {boolean} - Whether to automatically recover for illegal paths.
   *   - `targetName` {string} - Label used in messages for the path being resolved.
   * @throws {Error} if a jail is specified and the resolved path is outside it.
   * @returns {string} the resolved String path.
   */
  normalizeSystemPath(target, start = null, jail = null, opts = {}) {
    const doc = this.document;
    if (doc.safe < SafeMode.SAFE) {
      if (start) {
        if (!doc.pathResolver.isRoot(start)) start = `${doc.baseDir}/${start}`;
      } else {
        start = doc.baseDir;
      }
    } else {
      start = start ?? doc.baseDir;
      jail = jail ?? doc.baseDir;
    }
    return doc.pathResolver.systemPath(target, start, jail, opts)
  }

  /**
   * Normalize the web path using the PathResolver.
   *
   * @param {string} target - The String target path.
   * @param {string|null} [start=null] - The String start (parent) path.
   * @param {boolean} [preserveUriTarget=true] - Whether a URI target should be preserved as-is.
   * @returns {string} the resolved String path.
   */
  normalizeWebPath(target, start = null, preserveUriTarget = true) {
    if (preserveUriTarget && isUriish(target)) return encodeSpacesInUri(target)
    return this.document.pathResolver.webPath(target, start)
  }

  /**
   * Read the contents of the file at the specified path.
   *
   * This method checks that the file is readable before attempting to read it.
   *
   * @param {string} path - The String path from which to read the contents.
   * @param {Object} [opts={}] - A plain object of options:
   *   - `warnOnFailure` {boolean} - Whether a warning is issued when the file cannot be read (default: false).
   *   - `normalize` {boolean} - Whether lines are normalized and coerced to UTF-8 (default: false).
   *   - `label` {string} - Label for the file used in warning messages.
   * @returns {Promise<string|null>} a Promise resolving to the file content, or null if not readable.
   */
  async readAsset(path, opts = {}) {
    // remap opts for backwards compatibility (boolean shorthand)
    if (typeof opts !== 'object' || opts === null) opts = { warnOnFailure: opts !== false };
    if (isUriish(path)) {
      // Browser: docdir is a URL so the resolved path is an HTTP URI; use fetch instead of fs.
      const { readBrowserAsset } = await Promise.resolve().then(function () { return asset; });
      const text = await readBrowserAsset(path);
      if (text != null) return opts.normalize ? prepareSourceString(text).join(LF$1) : text
      if (opts.warnOnFailure) {
        const docfile = this.attr('docfile') || '<stdin>';
        const label = opts.label || 'file';
        this.logger.warn(`${docfile}: ${label} does not exist or cannot be read: ${path}`);
      }
      return null
    }
    if (await isReadable(path)) {
      if (opts.normalize) {
        return prepareSourceString(await _fsp$1.readFile(path, 'utf8')).join(LF$1)
      }
      return _fsp$1.readFile(path, 'utf8')
    }
    if (opts.warnOnFailure) {
      const docfile = this.attr('docfile') || '<stdin>';
      const label = opts.label || 'file';
      this.logger.warn(`${docfile}: ${label} does not exist or cannot be read: ${path}`);
    }
    return null
  }

  /**
   * Resolve the URI or system path to the target, then read and return its contents.
   *
   * When the resolved path is a URI and allow-uri-read is enabled, the content is
   * fetched via the Fetch API (async). When it is a local path, the file is read
   * via {@link readAsset}.
   *
   * @param {string} target - The URI or local path String from which to read the data.
   * @param {Object} [opts={}] - A plain object of options:
   *   - `label` {string} - Label used in warning messages (default: 'asset').
   *   - `normalize` {boolean} - Whether the data should be normalized (default: false).
   *   - `start` {string} - Relative base path for resolving the target.
   *   - `warnOnFailure` {boolean} - Whether warnings are issued on failure (default: true).
   *   - `warnIfEmpty` {boolean} - Whether a warning is issued when the target contents are empty (default: false).
   * @returns {Promise<string|null>} a Promise resolving to the content, or null on failure.
   */
  async readContents(target, opts = {}) {
    const doc = this.document;
    const label = opts.label || 'asset';
    let contents;
    let resolvedTarget = target;
    const start = opts.start;
    const warnOnFailure = opts.warnOnFailure !== false;

    if (isUriish(target) || (start && isUriish(start) && (resolvedTarget = doc.pathResolver.webPath(target, start)))) {
      if (doc.hasAttr('allow-uri-read')) {
        try {
          const response = await fetch(resolvedTarget);
          const text = await response.text();
          contents = opts.normalize ? prepareSourceString(text).join(LF$1) : text;
        } catch {
          if (warnOnFailure) this.logger.warn(`could not retrieve contents of ${label} at URI: ${resolvedTarget}`);
        }
      } else if (warnOnFailure) {
        this.logger.warn(`cannot retrieve contents of ${label} at URI: ${resolvedTarget} (allow-uri-read attribute not enabled)`);
      }
    } else {
      resolvedTarget = this.normalizeSystemPath(target, opts.start, null, { targetName: label });
      contents = await this.readAsset(resolvedTarget, { normalize: opts.normalize, warnOnFailure, label });
    }

    if (contents && opts.warnIfEmpty && contents.length === 0) {
      this.logger.warn(`contents of ${label} is empty: ${resolvedTarget}`);
    }
    return contents
  }

  /**
   * @deprecated Use {@link isUriish} from helpers.js instead.
   * @param {string} str
   * @returns {boolean}
   */
  isUri(str) {
    return isUriish(str)
  }

  /**
   * Provide a default logger.
   * The Logging mixin (logging.js) overrides this getter on the prototype.
   */
  get logger() {
    return this.document?.logger ?? console
  }
}

// ESM conversion of abstract_block.rb
//
// Ruby-to-JavaScript notes:
//   - AbstractBlock extends AbstractNode (class inheritance, not mixin).
//   - Ruby symbols (:compound, :section, …) are represented as plain strings.
//   - attr_reader / attr_writer / attr_accessor are plain instance properties.
//   - title has a getter/setter pair because the getter memoises the result of
//     applying substitutions; the setter clears that cache.
//   - caption has a getter/setter pair because the getter has special logic for
//     admonition blocks (returns 'textlabel' attribute instead).
//   - The context= setter in Ruby (def context= context) is exposed as setContext()
//     rather than a JS set accessor, to avoid getter/setter shadowing issues with
//     AbstractNode's plain this.context property.
//   - Ruby's number / number= (deprecated section numeral accessors) become
//     get number() / set number() JS accessors.
//   - The find_by Ruby block argument becomes a filter function (null if omitted).
//   - Ruby's StopIteration mechanism is replicated with a private StopIteration
//     class thrown and caught only within findBy / #findByInternal.
//   - find_by_internal is protected in Ruby; in JS it is a private method (#).
//     Because JS private methods are accessible across instances of the same class
//     from within the class body, recursive calls on child blocks still work.
//   - Ruby's Array#flatten (used for dlist blocks) → Array#flat().
//   - nil_or_empty? → falsy check (!val) since both null and '' are falsy in JS.
//   - String#chomp(sep) → str.endsWith(sep) ? str.slice(0, -sep.length) : str.
//   - Substitutors methods referenced: applyTitleSubs, subSpecialchars,
//     subReplacements, subQuotes, subPlaceholder (mixed in externally).
//   - document.incrementAndStoreCounter / document.counter translate
//     Ruby's increment_and_store_counter / counter.


/** Used as a sentinel to abort findBy traversal early (mirrors Ruby StopIteration). */
class StopIteration extends Error {}

/**
 * @template {string | any[]} [TContent=string]
 */
class AbstractBlock extends AbstractNode {
  /** @type {string|null} */
  #title = null
  /** @type {string|null} */
  #convertedTitle = null
  /** @type {string|null} */
  #caption = null

  constructor (parent, context, opts = {}) {
    super(parent, context, opts);
    this.contentModel = 'compound';
    this.blocks = [];
    this.subs = [];
    this.#title = null;
    this.#caption = null;
    this.numeral = null;
    this.style = null;
    this.defaultSubs = null;
    this.sourceLocation = null;
    if (context === 'document' || context === 'section') {
      this.level = 0;
      this._nextSectionIndex = 0;
      this._nextSectionOrdinal = 1;
    } else if (parent instanceof AbstractBlock) {
      this.level = parent.level;
    } else {
      this.level = null;
    }
  }

  isBlock () { return true }
  isInline () { return false }

  /**
   * Get the String title of this block with title substitutions applied.
   * The result is pre-computed during Document.parse() via precomputeTitle().
   * Falls back to applyHeaderSubs (sync) if precomputeTitle() has not been called yet
   * (e.g. when a title is set via the API after parsing).
   * @returns {string|null} the converted String title, or null if the source title is falsy.
   */
  get title () {
    if (this.#convertedTitle != null) return this.#convertedTitle
    if (this.#title == null) return null
    // Pre-computation hasn't run (title set after parse, or parse not yet done).
    // Apply the synchronous header subs (specialcharacters + attributes) as a best-effort.
    return this.applyHeaderSubs(this.#title)
  }

  /**
   * Pre-compute the converted title asynchronously.
   * Called during Document.parse() so the synchronous getter works during conversion.
   * Re-entrant calls (circular title references) are detected via _computingTitle and
   * silently skipped so that Section#xreftext() can return null (→ "[refid]" fallback).
   * @returns {Promise<void>}
   */
  async precomputeTitle () {
    if (this.#title && this.#convertedTitle == null && !this._computingTitle) {
      this._computingTitle = true;
      try {
        this.#convertedTitle = await this.applyTitleSubs(this.#title);
      } finally {
        this._computingTitle = false;
      }
    }
  }

  /**
   * @internal Get the raw (unsubstituted) title as set by the parser.
   * @returns {string|null}
   */
  get rawTitle () { return this.#title }

  /**
   * @internal Get the title with only attribute substitutions applied (no specialchars).
   * @note no longer used for section ID generation (parser now calls applyTitleSubs to match
   * Ruby's behaviour). Kept for other callers that need a lightweight sync substitution.
   * @returns {string|null}
   */
  get attrSubstitutedTitle () {
    const raw = this.#title;
    if (raw == null) return null
    return raw.includes('{') ? this.subAttributes(raw) : raw
  }

  /**
   * Set the String block title (clears the memoised converted title).
   * @param {string|null} val
   */
  set title (val) {
    this.#convertedTitle = null;
    this.#title = val;
  }

  /**
   * Check whether the title of this block is defined.
   * @returns {boolean}
   */
  hasTitle () { return !!this.#title }

  /**
   * Get the caption for this block.
   * For admonition blocks, returns the 'textlabel' attribute instead.
   * @returns {string|null}
   */
  get caption () {
    return this.context === 'admonition' ? this.attributes.textlabel : this.#caption
  }

  /**
   * Set the caption for this block.
   * @param {string|null} val
   */
  set caption (val) { this.#caption = val; }

  /**
   * Get the source file where this block started.
   * @returns {string|null}
   */
  get file () { return this.sourceLocation && this.sourceLocation.file }

  /**
   * Get the source line number where this block started.
   * @returns {number|null}
   */
  get lineno () { return this.sourceLocation && this.sourceLocation.lineno }

  /**
   * Update the context of this block, also updating the node name.
   * @param {string} context - The String context to assign to this block.
   */
  setContext (context) {
    this.context = context;
    this.nodeName = String(context);
  }

  /**
   * @deprecated Get/set the numeral of this section as an integer when possible.
   * @returns {number|string}
   */
  get number () {
    const n = parseInt(this.numeral, 10);
    return String(n) === String(this.numeral) ? n : this.numeral
  }

  /**
   * @deprecated
   * @param {number|string} val
   */
  set number (val) { this.numeral = String(val); }

  /**
   * Convert this block and return the converted String content.
   * @returns {Promise<string>} the result of the converter.
   */
  async convert () {
    this.document.playbackAttributes(this.attributes);
    return this.converter.convert(this)
  }

  /** @deprecated Use convert() instead. */
  render () { return this.convert() }

  /**
   * Get the converted result of all child blocks joined with a newline.
   * @returns {Promise<TContent>}
   */
  async content () {
    const results = [];
    for (const b of this.blocks) results.push(await b.convert());
    return results.join(LF$1)
  }

  /**
   * Alias for the content method — mirrors the core API.
   * @returns {Promise<TContent>}
   */
  getContent () { return this.content() }

  /**
   * Append a content block to this block's list of blocks.
   * @param {AbstractBlock} block - The new child block.
   * @returns {this} this block (enables chaining).
   */
  append (block) {
    if (block.parent !== this) block.parent = this;
    this.blocks.push(block);
    return this
  }

  /**
   * Determine whether this block contains block content.
   * @returns {boolean}
   */
  hasBlocks () { return this.blocks.length > 0 }

  /**
   * Check whether this block has any child Section objects.
   * Overridden by Document and Section.
   * @returns {boolean}
   */
  hasSections () { return false }

  /**
   * Get the child Section objects of this block.
   * Only applies to Document and Section instances.
   * @returns {AbstractBlock[]} array of Section objects (may be empty).
   */
  sections () {
    return this.blocks.filter(b => b.context === 'section')
  }

  /**
   * Get the converted alt text for this block image.
   * @returns {string} string with XML special character and replacement substitutions applied.
   */
  alt () {
    const text = this.attributes.alt;
    if (text) {
      if (text === this.attributes['default-alt']) return this.subSpecialchars(text)
      const escaped = this.subSpecialchars(text);
      return ReplaceableTextRx.test(escaped) ? this.subReplacements(escaped) : escaped
    }
    return ''
  }

  /**
   * Get the converted alt text for this block image (alias of alt).
   * @returns {string}
   */
  getAlt () { return this.alt() }

  /**
   * Get the converted title prefixed with the caption.
   * @returns {string} the captioned title.
   */
  captionedTitle () {
    return `${this.caption || ''}${this.title || ''}`
  }

  /**
   * Get the list marker keyword for the specified list type.
   * @param {string|null} [listType=null] - The String list type (default: this.style).
   * @returns {string|undefined} the single-character String keyword for the list marker.
   */
  listMarkerKeyword (listType = null) {
    return ORDERED_LIST_KEYWORDS[listType || this.style]
  }

  /**
   * Check whether the specified substitution is enabled for this block.
   * @param {string} name - The String substitution name.
   * @returns {boolean}
   */
  hasSub (name) { return this.subs.includes(name) }

  /**
   * Remove a substitution from this block.
   * @param {string} name - The String substitution name to remove.
   */
  removeSub (name) {
    const idx = this.subs.indexOf(name);
    if (idx >= 0) this.subs.splice(idx, 1);
  }

  /**
   * Generate cross-reference text (xreftext) used to refer to this block.
   * Uses the explicit reftext if set. For sections or captioned blocks (blocks
   * with both a title and a caption), formats the text according to xrefstyle.
   * Falls back to the title, or null if no title is available.
   * @param {string|null} [xrefstyle=null] - Optional String style: 'full', 'short', or 'basic'.
   * @returns {Promise<string|null>} the xreftext, or null.
   */
  async xreftext (xrefstyle = null) {
    const val = this.reftext;
    if (val && val.length > 0) return val
    if (xrefstyle && this.#title && this.#caption) {
      if (xrefstyle === 'full') {
        const quoteTemplate = this.document.compatMode ? "``%s''" : '"`%s`"';
        const quotedTitle = this.subPlaceholder(await this.subQuotes(quoteTemplate), this.title);
        if (this.numeral) {
          const captionAttrName = CAPTION_ATTRIBUTE_NAMES[this.context];
          if (captionAttrName) {
            const prefix = this.document.attributes[captionAttrName];
            if (prefix) return `${prefix} ${this.numeral}, ${quotedTitle}`
          }
        }
        const cap = this.#caption;
        return `${cap.endsWith('. ') ? cap.slice(0, -2) : cap}, ${quotedTitle}`
      } else if (xrefstyle === 'short') {
        if (this.numeral) {
          const captionAttrName = CAPTION_ATTRIBUTE_NAMES[this.context];
          if (captionAttrName) {
            const prefix = this.document.attributes[captionAttrName];
            if (prefix) return `${prefix} ${this.numeral}`
          }
        }
        const cap = this.#caption;
        return cap.endsWith('. ') ? cap.slice(0, -2) : cap
      }
    }
    return this.title
  }

  /**
   * Generate and assign a caption to this block if not already assigned.
   * If the block has a title and a caption prefix is available, builds a caption
   * from the prefix and a counter, then stores it.
   * @param {string|null} [value=null] - The String caption to assign, or null to derive from document attributes.
   * @param {string} [captionContext=this.context] - The String context used to look up caption attributes.
   */
  assignCaption (value = null, captionContext = this.context) {
    // In Ruby, empty string is truthy; use != null to replicate that semantics.
    if (this.#caption != null || !this.#title) return
    const globalCaption = this.document.attributes.caption;
    // Explicit value (even '') or a global :caption: attribute (even empty) takes precedence and
    // suppresses auto-numbering, matching Ruby's behaviour where any truthy assignment wins.
    if (value != null || globalCaption != null) {
      this.#caption = value != null ? value : globalCaption;
    } else {
      const attrName = CAPTION_ATTRIBUTE_NAMES[captionContext];
      if (attrName) {
        const prefix = this.document.attributes[attrName];
        if (prefix) {
          this.numeral = this.document.incrementAndStoreCounter(`${captionContext}-number`, this);
          this.#caption = `${prefix} ${this.numeral}. `;
        }
      }
    }
  }

  /**
   * @internal Assign the next index (0-based) and numeral (1-based) to the section.
   * @param {AbstractBlock} section - The Section to which to assign the next index and numeral.
   */
  assignNumeral (section) {
    section.index = this._nextSectionIndex;
    this._nextSectionIndex = section.index + 1;
    const like = section.numbered;
    if (like) {
      const sectname = section.sectname;
      if (sectname === 'appendix') {
        section.numeral = this.document.counter('appendix-number', 'A');
        const captionAttr = this.document.attributes['appendix-caption'];
        section.caption = captionAttr
          ? `${captionAttr} ${section.numeral}: `
          : `${section.numeral}. `;
      } else if (sectname === 'chapter' || like === 'chapter') {
        section.numeral = String(this.document.counter('chapter-number', 1));
      } else {
        section.numeral = sectname === 'part'
          ? intToRoman(this._nextSectionOrdinal)
          : String(this._nextSectionOrdinal);
        this._nextSectionOrdinal++;
      }
    }
  }

  /**
   * @internal Reassign 0-based section indexes for all descendant sections.
   * Must be called after removing child sections to keep internal counters correct.
   */
  reindexSections () {
    this._nextSectionIndex = 0;
    this._nextSectionOrdinal = 1;
    for (const block of this.blocks) {
      if (block.context === 'section') {
        this.assignNumeral(block);
        block.reindexSections();
      }
    }
  }

  /**
   * Walk the document tree and find all block-level nodes that match
   * the selector and optional filter function.
   * @param {Object} [selector={}] - A plain object with optional keys: context, style, role, id, traverseDocuments.
   * @param {Function|null} [filter=null] - An optional Function called with each candidate node.
   *   Return values: true/truthy → accept node; 'prune' → accept, skip children;
   *   'reject' → skip node and children; 'stop' → stop traversal.
   * @returns {AbstractBlock[]} array of matching block-level nodes.
   */
  findBy (selector = {}, filter = null) {
    const result = [];
    try {
      this.#findByInternal(selector, result, filter);
    } catch (e) {
      if (!(e instanceof StopIteration)) throw e
    }
    return result
  }

  /** Alias for findBy (matches Ruby's `alias query find_by`). */
  query (selector = {}, filter = null) { return this.findBy(selector, filter) }

  /**
   * Move to the next adjacent block in document order.
   * If the current block is the last item in a list, returns the following
   * sibling of the list block.
   * @returns {AbstractBlock|null} the next AbstractBlock, or null.
   */
  nextAdjacentBlock () {
    if (this.context === 'document') return null
    const p = this.parent;
    if (p.context === 'dlist' && this.context === 'list_item') {
      const idx = p.items.findIndex(([terms, desc]) => terms.includes(this) || desc === this);
      const sib = p.items[idx + 1];
      return sib ? sib : p.nextAdjacentBlock()
    }
    const idx = p.blocks.indexOf(this);
    const sib = p.blocks[idx + 1];
    return sib ? sib : p.nextAdjacentBlock()
  }

  /** @private Core traversal logic for findBy. Throws StopIteration for early exit. */
  #findByInternal (selector, result, filter) {
    const contextSelector = selector.context ?? null;
    const anyContext = !contextSelector;
    const styleSelector = selector.style ?? null;
    const roleSelector = selector.role ?? null;
    const idSelector = selector.id ?? null;

    if (
      (anyContext || contextSelector === this.context) &&
      (!styleSelector || styleSelector === this.style) &&
      (!roleSelector || this.hasRole(roleSelector)) &&
      (!idSelector || idSelector === this.id)
    ) {
      if (filter) {
        const verdict = filter(this);
        if (verdict) {
          if (verdict === 'prune') {
            result.push(this);
            if (idSelector) throw new StopIteration()
            return result
          } else if (verdict === 'reject') {
            if (idSelector) throw new StopIteration()
            return result
          } else if (verdict === 'stop') {
            throw new StopIteration()
          } else {
            result.push(this);
            if (idSelector) throw new StopIteration()
          }
        } else if (idSelector) {
          throw new StopIteration()
        }
      } else {
        result.push(this);
        if (idSelector) throw new StopIteration()
      }
    }

    if (this.context === 'document') {
      if (contextSelector !== 'document') {
        // Process document header as a section if present
        if (this.hasHeader?.() && (anyContext || contextSelector === 'section')) {
          this.header.#findByInternal(selector, result, filter);
        }
        for (const b of this.blocks) {
          if (contextSelector === 'section' && b.context !== 'section') continue // optimisation
          b.#findByInternal(selector, result, filter);
        }
      }
    } else if (this.context === 'dlist') {
      if (anyContext || contextSelector !== 'section') { // optimisation
        // NOTE dlist items can be null
        for (const b of this.blocks.flat()) {
          if (b) b.#findByInternal(selector, result, filter);
        }
      }
    } else if (this.context === 'table') {
      if (selector.traverseDocuments) {
        for (const r of this.rows.head) for (const c of r) c.#findByInternal(selector, result, filter);
        const innerSelector = contextSelector === 'inner_document' ? { ...selector, context: 'document' } : selector;
        for (const r of [...this.rows.body, ...this.rows.foot]) {
          for (const c of r) {
            c.#findByInternal(innerSelector, result, filter);
            if (c.style === 'asciidoc') c.innerDocument.#findByInternal(innerSelector, result, filter);
          }
        }
      } else {
        for (const r of [...this.rows.head, ...this.rows.body, ...this.rows.foot]) {
          for (const c of r) c.#findByInternal(selector, result, filter);
        }
      }
    } else {
      for (const b of this.blocks) {
        if (contextSelector === 'section' && b.context !== 'section') continue // optimisation
        b.#findByInternal(selector, result, filter);
      }
    }

    return result
  }

  // ── JavaScript-style accessors ────────────────────────────────────────────────

  /**
   * Get the context (node type) of this block.
   * @returns {string}
   */
  getContext () { return this.context }

  /**
   * Get the content model of this block.
   * @returns {string}
   */
  getContentModel () { return this.contentModel }

  /**
   * Set the content model of this block.
   * @param {string} val
   */
  setContentModel (val) { this.contentModel = val; }

  /**
   * Get the node name of this block.
   * @returns {string}
   */
  getNodeName () { return this.nodeName }

  /**
   * Get the child blocks of this block.
   * @returns {AbstractBlock[]}
   */
  getBlocks () { return this.blocks }

  /**
   * Get the child Section blocks of this block.
   * @returns {AbstractBlock[]}
   */
  getSections () { return this.sections() }

  /**
   * Get the title of this block with substitutions applied.
   * @returns {string|null}
   */
  getTitle () { return this.title }

  /**
   * Set the raw title of this block.
   * @param {string|null} val
   */
  setTitle (val) { this.title = val ?? null; }

  /**
   * Get the caption of this block.
   * @returns {string|undefined}
   */
  getCaption () { return this.caption ?? undefined }

  /**
   * Set the caption of this block.
   * @param {string|null} val
   */
  setCaption (val) { this.caption = val; }

  /**
   * Get the captioned title of this block.
   * @returns {string}
   */
  getCaptionedTitle () { return this.captionedTitle() }

  /**
   * Get the style of this block.
   * @returns {string|null}
   */
  getStyle () { return this.style }

  /**
   * Set the style of this block.
   * @param {string|null} val
   */
  setStyle (val) { this.style = val; }

  /**
   * Get the level of this block.
   * @returns {number|null}
   */
  getLevel () { return this.level }

  /**
   * Set the level of this block.
   * @param {number|null} val
   */
  setLevel (val) { this.level = val; }

  /**
   * Get the source line number where this block started.
   * @returns {number|undefined} line number, or undefined when sourcemap is disabled.
   */
  getLineNumber () { return this.sourceLocation?.lineno }

  /**
   * Get the source location of this block.
   * @returns {object|undefined} the Cursor source location object, or undefined when sourcemap is disabled.
   */
  getSourceLocation () { return this.sourceLocation ?? undefined }

  /**
   * Get the list of substitutions enabled for this block.
   * @returns {string[]}
   */
  getSubstitutions () { return this.subs }

  /**
   * Check whether the specified substitution is enabled for this block.
   * @param {string} name
   * @returns {boolean}
   */
  hasSubstitution (name) { return this.hasSub(name) }

  /**
   * Add the specified substitution to this block's substitutions list.
   * @param {string} name
   */
  addSubstitution (name) {
    if (!this.subs.includes(name)) this.subs.push(name);
  }

  /**
   * Remove the specified substitution from this block's substitutions list.
   * @param {string} name
   */
  removeSubstitution (name) { this.removeSub(name); }
}

// ESM conversion of the Compliance module (defined inside asciidoctor.rb).
//
// Ruby-to-JavaScript notes:
//   - The Ruby module uses dynamic attr_accessor generation via `define`.
//     In JS each flag is a plain enumerable property on the exported object.
//   - The `keys` Set is retained so callers can enumerate all known flags
//     (used e.g. by the options-merging code in Document).
//   - All default values match the Asciidoctor defaults (not the "AsciiDoc
//     compliance values" documented in comments — those differ intentionally).

const Compliance = {
  // AsciiDoc does not parse paragraphs with a verbatim style as verbatim
  // content. Compliance value: false (Asciidoctor default: true)
  strictVerbatimParagraphs: true,

  // AsciiDoc drops lines that contain references to missing attributes.
  // Possible values: 'skip', 'drop', 'drop-line', 'warn'.
  // Compliance value: 'drop-line' (Asciidoctor default: 'skip')
  attributeMissing: 'skip',

  // AsciiDoc drops lines that contain an attribute unassignment.
  // Compliance value: 'drop-line'
  attributeUndefined: 'drop-line',

  // Shorthand syntax for id, role and options on blocks (e.g. #id.role%opt).
  // Compliance value: false (Asciidoctor default: true)
  shorthandPropertySyntax: true,

  // Starting counter when generating a unique id on conflict.
  // Compliance value: 2
  uniqueIdStartIndex: 2};

// ESM conversion of section.rb


/**
 * Methods for managing sections of AsciiDoc content in a document.
 */
class Section extends AbstractBlock {
  /**
   * Create a new Section — mirrors the core Section.create() API.
   * @param {AbstractBlock|null} [parent=null]
   * @param {number|null} [level=null]
   * @param {boolean} [numbered=false]
   * @param {Object} [opts={}]
   * @returns {Section}
   */
  static create (parent = null, level = null, numbered = false, opts = {}) {
    return new Section(parent, level, numbered, opts)
  }

  /**
   * Initialize an Asciidoctor Section object.
   * @param {AbstractBlock|null} [parent=null] - The parent AbstractBlock (Document or Section), or null.
   * @param {number|null} [level=null] - The Integer level of this section (default: parent.level + 1 or 1).
   * @param {boolean} [numbered=false] - Boolean indicating whether numbering is enabled.
   * @param {Object} [opts={}] - An optional plain object of options.
   */
  constructor (parent = null, level = null, numbered = false, opts = {}) {
    super(parent, 'section', opts);
    if (parent instanceof Section) {
      this.level   = level ?? (parent.level + 1);
      this.special = parent.special;
    } else {
      this.level   = level ?? 1;
      this.special = false;
    }
    this.numbered  = numbered;
    this.index     = 0;
    this.sectname  = null;
  }

  /**
   * The name of this section — alias for title.
   * @returns {string|null}
   */
  get name () { return this.title }

  /**
   * Check whether this section has any child Section objects.
   * @returns {boolean}
   */
  hasSections () { return this._nextSectionIndex > 0 }

  /**
   * Generate a String ID from the title of this section.
   * This sync convenience method is only called outside of parsing (e.g. extensions).
   * At that point #convertedTitle is already set, so this.title returns the fully-substituted
   * HTML title — matching Ruby's behaviour where section.title calls apply_title_subs.
   * @returns {string}
   */
  generateId () {
    return Section.generateId(this.title, this.document)
  }

  /**
   * Get the section number for the current Section as a dot-separated String.
   * @param {string} [delimiter='.'] - The separator between numerals.
   * @param {string|false|null} [append=null] - String appended at the end, or false to omit trailing delimiter
   *   (default: null → same as delimiter).
   * @returns {string} the section number String.
   */
  sectnum (delimiter = '.', append = null) {
    const suffix = append !== null ? (append === false ? '' : append) : delimiter;
    if (this.level > 1 && this.parent instanceof Section) {
      return `${this.parent.sectnum(delimiter, delimiter)}${this.numeral ?? ''}${suffix}`
    }
    return `${this.numeral ?? ''}${suffix}`
  }

  /**
   * @inheritdoc
   * @param {string|null} [xrefstyle=null]
   * @returns {Promise<string|null>}
   */
  async xreftext (xrefstyle = null) {
    const val = this.reftext;
    if (val && val.length > 0) return val

    // If the title is currently being computed (circular reference), return null so that
    // the caller (convert_inline_anchor) falls back to the "[refid]" placeholder.
    if (this._computingTitle) return null

    // Compute the title now using the current catalog state if not already done.
    // This ensures that forward xrefs in a section title are not resolved when the
    // xreftext is first requested during parsing (before the target is registered).
    await this.precomputeTitle();

    if (xrefstyle) {
      if (this.numbered) {
        const type = this.sectname;
        switch (xrefstyle) {
          case 'full': {
            let quotedTitle;
            if (type === 'chapter' || type === 'appendix') {
              quotedTitle = this.subPlaceholder(await this.subQuotes('_%s_'), this.title);
            } else {
              const q = this.document.compatMode ? "``%s''" : '"`%s`"';
              quotedTitle = this.subPlaceholder(await this.subQuotes(q), this.title);
            }
            const signifier = this.document.attributes[`${type}-refsig`];
            return signifier
              ? `${signifier} ${this.sectnum('.', ',')} ${quotedTitle}`
              : `${this.sectnum('.', ',')} ${quotedTitle}`
          }
          case 'short': {
            const signifier = this.document.attributes[`${this.sectname}-refsig`];
            return signifier
              ? `${signifier} ${this.sectnum('.', '')}`
              : this.sectnum('.', '')
          }
          default: { // 'basic'
            const t = this.sectname;
            return (t === 'chapter' || t === 'appendix')
              ? this.subPlaceholder(await this.subQuotes('_%s_'), this.title)
              : this.title
          }
        }
      } else {
        // apply basic styling
        const t = this.sectname;
        return (t === 'chapter' || t === 'appendix')
          ? this.subPlaceholder(await this.subQuotes('_%s_'), this.title)
          : this.title
      }
    }
    return this.title
  }

  /**
   * Append a content block to this block's list of blocks.
   * If the child block is a Section, assign an index/numeral to it.
   * @param {AbstractBlock} block - The child Block to append.
   * @returns {this}
   */
  append (block) {
    if (block.context === 'section') this.assignNumeral(block);
    return super.append(block)
  }

  // ── JavaScript-style accessors ────────────────────────────────────────────────

  /**
   * Get the section title (alias of title).
   * @returns {string|null}
   */
  getName () { return this.name }

  /**
   * Get the section name (e.g. 'section', 'appendix').
   * @returns {string|null}
   */
  getSectionName () { return this.sectname ?? undefined }

  /**
   * Get the 0-based index of this section within the parent block.
   * @returns {number}
   */
  getIndex () { return this.index }

  /**
   * Get whether this section is numbered.
   * @returns {boolean}
   */
  isNumbered () { return this.numbered }

  /**
   * Get whether this section is a special section.
   * @returns {boolean}
   */
  isSpecial () { return this.special }

  /**
   * Get the section numeral string.
   * @returns {string|null}
   */
  getNumeral () { return this.numeral }

  /**
   * Set the section numeral string.
   * @param {string|null} val
   */
  setNumeral (val) { this.numeral = val; }

  /**
   * Get the section number string (dot-separated).
   * @returns {string}
   */
  getSectionNumeral () { return this.sectnum() }

  /**
   * Get the section number string (alias of getSectionNumeral).
   * @returns {string}
   */
  getSectionNumber () { return this.sectnum() }

  toString () {
    if (this._title) {
      const formalTitle = this.numbered ? `${this.sectnum()} ${this._title}` : this._title;
      return `#<Section {level: ${this.level}, title: ${JSON.stringify(formalTitle)}, blocks: ${this.blocks.length}}>`
    }
    return super.toString()
  }

  /**
   * Generate a String ID from the given section title.
   * @param {string} title - The String title.
   * @param {object} document - The Document.
   * @returns {string} the generated String ID.
   */
  static generateId (title, document) {
    const attrs = document.attributes;
    const pre   = attrs['idprefix'] ?? '_';
    let sep, sepSub, noSep;

    const rawSep = attrs['idseparator'];
    if (rawSep !== undefined && rawSep !== null) {
      if (rawSep.length === 0) {
        noSep = true;
        sep = '';
        sepSub = null;
      } else {
        // Use only first character if multi-character
        sep = rawSep.length === 1 ? rawSep : (attrs['idseparator'] = rawSep[0]);
        if (sep === '-' || sep === '.') {
          sepSub = ' .-';
        } else {
          sepSub = ` ${sep}.-`;
        }
      }
    } else {
      sep    = '_';
      sepSub = ' _.-';
    }

    let genId = `${pre}${title.toLowerCase().replace(new RegExp(InvalidSectionIdCharsRx.source, 'gu'), '')}`;

    if (noSep) {
      genId = genId.replace(/ /g, '');
    } else {
      // Replace chars in sepSub with sep and squeeze consecutive sep chars
      genId = _trS(genId, sepSub, sep);
      if (genId.endsWith(sep)) genId = genId.slice(0, -sep.length);
      // Ensure id doesn't begin with idseparator if idprefix is empty
      if (pre === '' && genId.startsWith(sep)) genId = genId.slice(sep.length);
    }

    const refs = document.catalog?.refs;
    if (refs && genId in refs) {
      let cnt = Compliance.uniqueIdStartIndex;
      let candidate;
      do {
        candidate = `${genId}${sep}${cnt}`;
        cnt++;
      } while (candidate in refs)
      return candidate
    }
    return genId
  }
}

/**
 * @internal Translate every character in `fromChars` to `toChar` and squeeze
 * consecutive runs of the translated character (mirrors Ruby's String#tr_s).
 * @param {string} str
 * @param {string} fromChars
 * @param {string} toChar
 * @returns {string}
 */
function _trS (str, fromChars, toChar) {
  const set = new Set([...fromChars]);
  let result = '';
  let prevWasSep = false;
  for (const ch of str) {
    if (set.has(ch)) {
      if (!prevWasSep) result += toChar;
      prevWasSep = true;
    } else {
      result += ch;
      prevWasSep = false;
    }
  }
  return result
}

// ESM conversion of block.rb


// Maps block context strings to their default content model.
// Any context not listed defaults to 'simple'.
const DEFAULT_CONTENT_MODEL = new Proxy(
  {
    audio:          'empty',
    image:          'empty',
    listing:        'verbatim',
    literal:        'verbatim',
    stem:           'raw',
    open:           'compound',
    page_break:     'empty',
    pass:           'raw',
    thematic_break: 'empty',
    video:          'empty',
  },
  { get: (target, key) => Object.prototype.hasOwnProperty.call(target, key) ? target[key] : 'simple' }
);

// Public: Methods for managing AsciiDoc content blocks.
class Block extends AbstractBlock {
  // Public: Factory method — mirrors the core Block.create(parent, context, opts) API.
  static create (parent, context, opts = {}) {
    return new Block(parent, context, opts)
  }
  // Public: Get/Set the original Array of source lines for this block.
  // lines

  // Public: Initialize an Asciidoctor::Block object.
  //
  // parent  - The parent AbstractBlock.
  // context - The String context name (e.g. 'paragraph', 'listing').
  // opts    - A plain object of options:
  //           content_model - 'compound', 'simple', 'verbatim', 'raw', 'empty'
  //                           (default: looked up from DEFAULT_CONTENT_MODEL)
  //           attributes    - Hash of attributes to merge in.
  //           source        - String or Array of raw source lines.
  //           subs          - :default | Array | String | null
  //           default_subs  - override for default subs (used with subs: :default)
  constructor (parent, context, opts = {}) {
    super(parent, context, opts);
    this.contentModel = opts.content_model ?? DEFAULT_CONTENT_MODEL[context];

    if ('subs' in opts) {
      const subs = opts.subs;
      if (subs) {
        if (subs === 'default') {
          // subs attribute is honored; falls back to opts.default_subs then built-in defaults
          this.defaultSubs = opts.default_subs ?? null;
        } else if (Array.isArray(subs)) {
          // subs attribute is not honored; use provided array directly
          this.defaultSubs = [...subs];
          delete this.attributes.subs;
        } else {
          // e.g. subs: 'normal' — subs attribute is not honored
          this.defaultSubs = null;
          this.attributes.subs = String(subs);
        }
        // Resolve subs eagerly when subs option is specified
        this.commitSubs();
      } else {
        // subs: null/[] — lock subs as empty; subsequent commitSubs() calls are no-ops
        this.defaultSubs = [];
        delete this.attributes.subs;
      }
    } else {
      // Defer subs resolution; subs attribute will be honored later
      this.defaultSubs = null;
    }

    const rawSource = opts.source;
    if (!rawSource && rawSource !== 0) {
      this.lines = [];
    } else if (typeof rawSource === 'string') {
      this.lines = prepareSourceString(rawSource);
    } else {
      this.lines = [...rawSource];
    }
  }

  // Public: Alias for context — consistent with AsciiDoc terminology.
  get blockname () { return this.context }

  // Public: Get the converted result appropriate to this block's content model.
  //
  // Returns a Promise<String> result.
  async content () {
    switch (this.contentModel) {
      case 'compound':
        return super.content()
      case 'simple':
        return this.applySubs(this.lines.join(LF$1), this.subs)
      case 'verbatim':
      case 'raw': {
        const result = await this.applySubs(this.lines, this.subs);
        if (result.length < 2) return result[0] ?? ''
        while (result.length > 0 && result[0].trimEnd() === '') result.shift();
        while (result.length > 0 && result[result.length - 1].trimEnd() === '') result.pop();
        return result.join(LF$1)
      }
      default:
        if (this.contentModel !== 'empty') {
          this.logger.warn(`unknown content model '${this.contentModel}' for block: ${this}`);
        }
        return null
    }
  }

  // Public: Returns the source lines for this block.
  // Matches the core API: block.getSourceLines() → Array of String.
  getSourceLines () { return this.lines }

  // Public: Returns the preprocessed source of this block as a single String.
  get source () {
    return this.lines.join(LF$1)
  }

  toString () {
    const contentSummary = this.contentModel === 'compound'
      ? `blocks: ${this.blocks.length}`
      : `lines: ${this.lines.length}`;
    return `#<Block {context: '${this.context}', content_model: '${this.contentModel}', style: ${JSON.stringify(this.style ?? null)}, ${contentSummary}}>`
  }
}

// ESM conversion of list.rb


const NORMAL_SUBS$1 = Object.freeze(['specialcharacters', 'quotes', 'attributes', 'replacements', 'macros', 'post_replacements']);

/**
 * @extends {AbstractBlock<any[]>}
 */
class List extends AbstractBlock {
  constructor (parent, context, opts = {}) {
    super(parent, context, opts);
  }

  /** Alias for blocks — the list items. */
  get items () { return this.blocks }

  /** Alias for blocks — the list content. */
  async content () { return this.blocks }

  /**
   * Check whether this list has items (blocks).
   * @returns {boolean}
   */
  hasItems () { return this.blocks.length > 0 }

  /**
   * Check whether this list is an outline list (unordered or ordered).
   * @returns {boolean}
   */
  outline () {
    return this.context === 'ulist' || this.context === 'olist'
  }

  /**
   * Convert this list, advancing the callout list pointer if a colist.
   * @returns {Promise<string>}
   */
  async convert () {
    const result = await super.convert();
    if (this.context === 'colist') this.document.callouts.nextList();
    return result
  }

  /**
   * @deprecated Use {@link convert} instead.
   */
  render () { return this.convert() }

  toString () {
    return `#<List {context: '${this.context}', style: ${JSON.stringify(this.style ?? null)}, items: ${this.blocks.length}}>`
  }
}

/**
 * Methods for managing items for AsciiDoc olists, ulists, and dlists.
 *
 * In a description list (dlist), each item is a tuple: `[[term, term, ...], desc]`.
 * If a description is not set, the second entry is null.
 */
class ListItem extends AbstractBlock {
  /**
   * The string marker used for this list item.
   * @type {string|null}
   */
  marker

  /**
   * @param {List} parent - The parent List block.
   * @param {string|null} [text=null] - The text of this item.
   */
  constructor (parent, text = null) {
    super(parent, 'list_item');
    this._text   = text;
    this.level   = parent.level;
    this.subs    = [...NORMAL_SUBS$1];
    this.marker  = null;
  }

  /** Contextual alias for parent. */
  get list () { return this.parent }

  /**
   * Check whether the text of this list item is non-blank.
   * @returns {boolean}
   */
  hasText () {
    return !!(this._text && this._text.length > 0)
  }

  /**
   * Get the string text with substitutions applied.
   * The result is pre-computed during `Document.parse()` via {@link precomputeText}.
   * Falls back to the raw text if {@link precomputeText} has not been called yet.
   *
   * In Ruby, text is lazy (`apply_subs` on first access), so API callers can modify
   * subs before accessing text and get the result they expect. Here we replicate
   * that by invalidating the pre-computed value when subs have changed since it
   * was computed: returning raw text mirrors what Ruby would produce when subs are
   * cleared or reduced to a no-op set (since `applySubs` is async and cannot be
   * re-run synchronously).
   * @returns {string|null}
   */
  get text () {
    if (this._convertedText != null && this._subsSnapshot != null) {
      const cur = this.subs;
      if (cur.length !== this._subsSnapshot.length || cur.some((s, i) => s !== this._subsSnapshot[i])) {
        return this._text ?? null
      }
    }
    return this._convertedText ?? this._text ?? null
  }

  /**
   * Pre-compute the converted text asynchronously.
   * Called during `Document.parse()` so the synchronous getter works during conversion.
   * @returns {Promise<void>}
   */
  async precomputeText () {
    if (this._text != null && this._convertedText == null) {
      this._convertedText = await this.applySubs(this._text, this.subs);
      this._subsSnapshot = [...this.subs];
    }
  }

  /**
   * Set the raw text of this list item.
   * @param {string|null} val
   */
  set text (val) { this._text = val; this._convertedText = null; this._subsSnapshot = null; }

  /**
   * Check whether this list item has simple content.
   * @returns {boolean} `true` if the item has no blocks or only a single nested outline list.
   */
  simple () {
    return this.blocks.length === 0 ||
      (this.blocks.length === 1 && this.blocks[0] instanceof List && this.blocks[0].outline())
  }

  /**
   * Check whether this list item has compound content.
   * @returns {boolean} `true` if the item contains blocks other than a single nested outline list.
   */
  compound () {
    return !this.simple()
  }

  /** @internal Fold the adjacent paragraph block into the list item text. */
  foldFirst () {
    const src = this.blocks.shift().source;
    this._text = (!this._text || this._text.length === 0) ? src : `${this._text}${LF$1}${src}`;
  }

  toString () {
    return `#<ListItem {list_context: '${this.parent.context}', text: ${JSON.stringify(this._text)}, blocks: ${(this.blocks ?? []).length}}>`
  }
}

// ESM conversion of inline.rb


/**
 * Represents an inline element in an AsciiDoc document.
 */
class Inline extends AbstractNode {
  /**
   * @param {AbstractNode} parent
   * @param {string} context
   * @param {string|null} [text=null] - The String text of this inline element.
   * @param {Object} [opts={}] - A plain object of options:
   *   id     - The String id of this inline element.
   *   type   - The String type qualifier (e.g. 'ref', 'bibref').
   *   target - The String target (e.g. a URI).
   */
  constructor (parent, context, text = null, opts = {}) {
    super(parent, context, opts);
    this.nodeName = `inline_${context}`;
    this.text = text;
    this.id = opts.id ?? null;
    this.type = opts.type ?? null;
    this.target = opts.target ?? null;
  }

  isBlock ()  { return false }
  isInline () { return true }

  /**
   * Convert this inline element using the document's converter.
   * @returns {Promise<string>}
   */
  async convert () { return this.converter.convert(this) }

  /** @deprecated Use convert() instead. */
  render () { return this.convert() }

  /**
   * Get the converted content (alias for text).
   * @returns {string|null}
   */
  content () { return this.text }

  /**
   * Get the alt text for this inline image.
   * @returns {string} the value of the alt attribute, or ''.
   */
  alt () { return this.attr('alt') || '' }

  /**
   * Check whether this inline node has reftext.
   * For ref and bibref nodes the text acts as the reftext.
   * @returns {boolean}
   */
  hasReftext () {
    return !!(this.text && (this.type === 'ref' || this.type === 'bibref'))
  }

  /**
   * Get the reftext for this inline node with substitutions applied.
   * The result is pre-computed during Document.parse() via precomputeReftext().
   * Falls back to the raw text if precomputeReftext() has not been called yet.
   * @returns {string|null}
   */
  get reftext () {
    if (this._convertedReftext !== undefined) return this._convertedReftext
    return this.text ?? null
  }

  /**
   * Pre-compute the reftext with substitutions applied asynchronously.
   * Called during Document.parse() so the synchronous getter works during conversion.
   * @returns {Promise<void>}
   */
  async precomputeReftext () {
    const val = this.text;
    this._convertedReftext = val != null ? await this.applyReftextSubs(val) : null;
  }

  /**
   * Generate xreftext for this inline node.
   * @param {string|null} [_xrefstyle=null]
   * @returns {string|null}
   */
  xreftext (_xrefstyle = null) { return this.reftext }
}

// Browser-specific include path resolution for PreprocessorReader.
//
// This module implements the logic described in docs/modules/spec/pages/browser-include-spec.adoc
// and mirrors packages/core/lib/asciidoctor/js/asciidoctor_ext/browser/reader.rb.
//
// This logic is specific to Asciidoctor.js and has no equivalent in the upstream Ruby asciidoctor
// implementation. It handles the case where the document is loaded in a browser environment
// (XMLHttpRequest / Fetch IO module) where paths can be file:// or http(s):// URIs.
//
// The key behavioural differences from the standard file-system resolver:
//   - Relative targets are resolved by string concatenation against a URI context dir,
//     not via OS path normalisation.
//   - Absolute paths (e.g. /foo/bar) are rewritten to file:///foo/bar.
//   - All resolved includes are fetched via the Fetch API (targetType 'uri').
//
// Public API
// ----------
// resolveBrowserIncludePath(reader, target, attrlist)
//   reader   - a PreprocessorReader instance (provides _document, includeStack, _dir,
//              replaceNextLine)
//   target   - the raw include target string
//   attrlist - the raw attribute list string (used for error-message link construction)
//
//   Returns [incPath, relpath] on success, where:
//     incPath  - the absolute URI to fetch
//     relpath  - the path relative to the document base dir (used for include tracking)
//   Returns true/false when the include directive line has already been consumed/replaced
//   (mirrors the Boolean return convention used by _resolveIncludePath in reader.js).


// Internal: Build the `link:...[...]` replacement text for a disallowed include.
function _linkReplacement (reader, target, attrlist) {
  const doc = reader._document;
  const lt = target.includes(' ') ? `pass:c[${target}]` : target;
  const la = doc.hasAttr('compat-mode') ? (attrlist ?? '') : `role=include${attrlist ? ',' + attrlist : ''}`;
  return `link:${lt}[${la}]`
}

// Public: Resolve an include path in a browser (URI-based) environment.
//
// Implements the rules from the browser-include-spec, in the same order:
//
// === Top-level include (includeStack is empty) ===
//
// 1. target starts with file:// → inc_path = relpath = target
// 2. target is a URI → must descend from baseDir or allow-uri-read; else → link
// 3. target is an absolute OS path → prepend file:// (or file:///)
// 4. baseDir == '.' → inc_path = relpath = target  (resolved by XMLHttpRequest/fetch)
// 5. baseDir starts with file:// OR baseDir is not a URI → inc_path = baseDir/target; relpath = target
// 6. baseDir is an absolute URL → inc_path = baseDir/target; relpath = target
//
// === Nested include (includeStack is non-empty) ===
//
// Rules 1–3 same as top-level.
// 4. parentDir == '.' → inc_path = relpath = target
// 5. parentDir starts with file:// OR parentDir is not a URI
//      → inc_path = parentDir/target
//      → relpath = inc_path if baseDir=='.' or inc_path not under baseDir, else path difference
// 6. parentDir is an absolute URL
//      → must descend from baseDir or allow-uri-read; else → link
//      → inc_path = parentDir/target
//      → relpath = path difference if parentDir descends from baseDir, else target
//
// Returns [incPath, relpath] or Boolean (replaceNextLine result).
function resolveBrowserIncludePath (reader, target, attrlist) {
  const doc = reader._document;
  const pathResolver = doc.pathResolver;
  // Normalise backslashes (Ruby: PathResolver.new('\\').posixify target)
  const pTarget = target.replace(/\\/g, '/');
  const baseDir = doc.baseDir;
  const topLevel = reader.includeStack.length === 0;
  const ctxDir = topLevel ? baseDir : reader._dir;

  let incPath, relpath;

  // ── Rule 1: target starts with file:// ────────────────────────────────────
  if (pTarget.startsWith('file://')) {
    incPath = relpath = pTarget;

  // ── Rule 2: target is an absolute URL (http:// / https:// / …) ───────────
  } else if (isUriish(pTarget)) {
    const descends = pathResolver.descendsFrom(pTarget, baseDir);
    if (descends === false && !doc.attr('allow-uri-read')) {
      return reader.replaceNextLine(_linkReplacement(reader, target, attrlist))
    }
    incPath = relpath = pTarget;

  // ── Rule 3: target is an absolute OS path ─────────────────────────────────
  } else if (pathResolver.absolutePath(pTarget)) {
    incPath = relpath = `file://${pTarget.startsWith('/') ? '' : '/'}${pTarget}`;

  // ── Rule 4: context dir is '.' ────────────────────────────────────────────
  // Relative path resolved by fetch relative to window.location / request origin.
  } else if (ctxDir === '.') {
    incPath = relpath = pTarget;

  // ── Rule 5: context dir is file:// OR a non-URI (regular OS path) ─────────
  } else if (ctxDir.startsWith('file://') || !isUriish(ctxDir)) {
    incPath = `${ctxDir}/${pTarget}`;
    if (topLevel) {
      relpath = pTarget;
    } else {
      const offset = pathResolver.descendsFrom(incPath, baseDir);
      if (baseDir === '.' || offset === false) {
        relpath = incPath;
      } else {
        relpath = incPath.slice(offset);
      }
    }

  // ── Rule 6: context dir is an absolute URL ────────────────────────────────
  } else if (topLevel) {
    incPath = `${ctxDir}/${relpath = pTarget}`;

  } else {
    // Nested include: context dir is an absolute URL.
    const ctxDescends = pathResolver.descendsFrom(ctxDir, baseDir);
    if (ctxDescends !== false || doc.attr('allow-uri-read')) {
      incPath = `${ctxDir}/${pTarget}`;
      relpath = ctxDescends !== false ? incPath.slice(ctxDescends) : pTarget;
    } else {
      return reader.replaceNextLine(_linkReplacement(reader, target, attrlist))
    }
  }

  return [incPath, relpath]
}

// ESM conversion of reader.rb
//
// Ruby-to-JavaScript notes:
//   - @lines is an Array used as a reversed stack: @lines[-1] is the next line.
//     In JS: this._lines[this._lines.length - 1] / this._lines.pop() / push().
//   - Ruby private methods called by subclasses (shift, unshift, unshift_all,
//     process_line, prepare_lines) use the _ prefix convention rather than JS
//     # private, because PreprocessorReader must be able to override/call them.
//   - JS # private fields are used only for data that is truly inaccessible to
//     subclasses and external callers (none here, to keep inheritance clean).
//   - PreprocessorReader overrides _shift() to strip the backslash from escaped
//     directives, mirroring the Ruby `def shift` override.
//   - PreprocessorReader overrides _prepareLines() to add front-matter handling
//     and indentation adjustment (mirrors `def prepare_lines`).
//   - The Logging mixin is implemented with inline helper methods; the logger
//     defaults to this._document?.logger ?? console.
//   - File I/O uses node:fs/promises async APIs (unavailable in browsers).
//   - URI-based includes use the async Fetch API.
//   - Compliance.attribute_missing defaults to 'skip' until compliance.js exists.
//   - Parser.adjustIndentation is referenced but forwarded as a TODO.
//   - RUBY_ENGINE_OPAL branches are omitted.
//   - JRuby-specific unshift_all variant is omitted; the standard branch is used.


// ── Node.js fs (lazy, optional) ───────────────────────────────────────────────
// Loaded on first use in Node.js; silently absent in browser/WebWorker environments.
let _fsp;            // undefined = not tried, null = unavailable, object = available
let _fsConstants;    // node:fs constants (F_OK etc.) — not on node:fs/promises

async function _requireFsp() {
  if (_fsp !== undefined) return
  try {
    _fsp = await import('node:fs/promises');
    _fsConstants = (await import('node:fs')).constants;
  } catch {
    _fsp = null;
  }
}

// ── path helpers (no node:path dependency) ───────────────────────────────────
function fsdirname (p) {
  if (!p) return '.'
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '.' : idx === 0 ? '/' : p.slice(0, idx)
}
function fsbasename (p) {
  return p ? p.slice(p.lastIndexOf('/') + 1) : ''
}
async function fileExists (path) {
  await _requireFsp();
  if (!_fsp) return false
  try { await _fsp.access(path, _fsConstants.F_OK); return true } catch { return false }
}

// ── adjustIndentation ─────────────────────────────────────────────────────────
// Port of Parser.adjust_indentation! from Ruby.
// Mutates `lines` in place to remove block indent, then optionally re-indent.
function _adjustIndentation (lines, indentSize, tabSize = 0) {
  if (lines.length === 0) return
  // Determine block indent (minimum leading spaces of non-blank lines)
  let blockIndent = null;
  for (const line of lines) {
    if (line === '') continue
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent === 0) { blockIndent = null; break }
    if (blockIndent === null || lineIndent < blockIndent) blockIndent = lineIndent;
  }
  if (indentSize === 0) {
    if (blockIndent) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== '') lines[i] = lines[i].slice(blockIndent);
      }
    }
  } else {
    const newIndent = ' '.repeat(indentSize);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== '') {
        lines[i] = blockIndent ? newIndent + lines[i].slice(blockIndent) : newIndent + lines[i];
      }
    }
  }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

class Cursor {
  constructor (file, dir = null, path = null, lineno = 1) {
    this.file = file;
    this.dir = dir;
    this.path = path;
    this.lineno = lineno;
  }

  advance (num) { this.lineno += num; }
  get lineInfo () { return `${this.path}: line ${this.lineno}` }
  toString () { return this.lineInfo }

  // Public API (mirrors Ruby Asciidoctor::Reader::Cursor)
  getLineNumber ()  { return this.lineno }
  getFile ()        { return this.file ?? undefined }
  getDirectory ()   { return this.dir }
  getPath ()        { return this.path }
}

// ── Reader ────────────────────────────────────────────────────────────────────

class Reader {
  constructor (data = null, cursor = null, opts = {}) {
    if (!cursor) {
      this.file = null;
      this._dir = '.';
      this.path = '<stdin>';
      this.lineno = 1;
    } else if (typeof cursor === 'string') {
      this.file = cursor;
      this._dir = fsdirname(cursor);
      this.path = fsbasename(cursor);
      this.lineno = 1;
    } else {
      if ((this.file = cursor.file)) {
        this._dir = cursor.dir || fsdirname(this.file);
        this.path = cursor.path || fsbasename(this.file);
      } else {
        this._dir = cursor.dir || '.';
        this.path = cursor.path || '<stdin>';
      }
      this.lineno = cursor.lineno || 1;
    }
    if (opts.document) this._document = opts.document;
    this.sourceLines = this._prepareLines(data, opts);
    this._lines = this.sourceLines.slice().reverse();
    this._mark = null;
    this._lookAhead = 0;
    this.processLines = true;
    this._unescapeNextLine = false;
    this.unterminated = null;
    this._saved = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  hasMoreLines () {
    if (this._lines.length === 0) { this._lookAhead = 0; return false }
    return true
  }

  empty () {
    if (this._lines.length === 0) { this._lookAhead = 0; return true }
    return false
  }
  eof () { return this.empty() }

  async nextLineEmpty () { const l = await this.peekLine(); return !l }
  async isNextLineEmpty () { return await this.nextLineEmpty() }

  // Public: Peek at the next line without consuming it.
  //
  // direct - When true, bypass processLine and return the raw stack top.
  //
  // Returns the String next line, or undefined if there are no more lines.
  async peekLine (direct = false) {
    while (true) {
      const nextLine = this._lines[this._lines.length - 1];
      if (direct || this._lookAhead > 0) {
        return this._unescapeNextLine ? nextLine.slice(1) : nextLine
      }
      if (nextLine !== undefined) {
        const line = await this.processLine(nextLine);
        if (line !== null && line !== undefined) return line
      } else {
        this._lookAhead = 0;
        return undefined
      }
    }
  }

  // Public: Peek at the next num lines without consuming them.
  async peekLines (num = null, direct = false) {
    const oldLookAhead = this._lookAhead;
    const result = [];
    const limit = num != null ? num : MAX_INT;
    for (let i = 0; i < limit; i++) {
      const line = direct ? this._shift() : await this.readLine();
      if (line !== undefined) {
        result.push(line);
      } else {
        if (direct) this.lineno--;
        break
      }
    }
    if (result.length > 0) {
      this._unshiftAll(result);
      if (direct) this._lookAhead = oldLookAhead;
    }
    return result
  }

  async readLine () {
    return (this._lookAhead > 0 || await this.hasMoreLines()) ? this._shift() : undefined
  }

  async readLines () {
    const lines = [];
    while (await this.hasMoreLines()) lines.push(this._shift());
    return lines
  }
  async readlines () { return await this.readLines() }

  async read () { return (await this.readLines()).join(LF$1) }

  async advance () { return this._shift() !== undefined }

  unshiftLine (lineToRestore) { this._unshift(lineToRestore); }
  restoreLine (lineToRestore) { this._unshift(lineToRestore); }

  unshiftLines (linesToRestore) { this._unshiftAll(linesToRestore); }
  restoreLines (linesToRestore) { this._unshiftAll(linesToRestore); }

  replaceNextLine (replacement) {
    this._shift();
    this._unshift(replacement);
    return true
  }
  replaceLine (replacement) { return this.replaceNextLine(replacement) }

  async skipBlankLines () {
    if (await this.empty()) return undefined
    let numSkipped = 0;
    let nextLine;
    while ((nextLine = await this.peekLine()) !== undefined) {
      if (String(nextLine) !== '') return numSkipped
      this._shift();
      numSkipped++;
    }
    return undefined
  }

  async skipCommentLines () {
    if (await this.empty()) return
    let nextLine;
    while ((nextLine = await this.peekLine()) !== undefined && nextLine !== '') {
      if (!nextLine.startsWith('//')) break
      if (nextLine.startsWith('///')) {
        const ll = nextLine.length;
        if (!(ll > 3 && nextLine === '/'.repeat(ll))) break
        await this.readLinesUntil({ terminator: nextLine, skipFirstLine: true, readLastLine: true, skipProcessing: true, context: 'comment' });
      } else {
        this._shift();
      }
    }
  }

  async skipLineComments () {
    if (await this.empty()) return []
    const commentLines = [];
    let nextLine;
    while ((nextLine = await this.peekLine()) !== undefined && nextLine !== '') {
      if (!nextLine.startsWith('//')) break
      commentLines.push(this._shift());
    }
    return commentLines
  }

  terminate () {
    this.lineno += this._lines.length;
    this._lines.length = 0;
    this._lookAhead = 0;
  }

  // Public: Read lines until a termination condition is met.
  //
  // options - Plain object:
  //   terminator            - String line at which to stop.
  //   breakOnBlankLines     - Stop on blank lines.
  //   breakOnListContinuation - Stop on a list continuation (+).
  //   skipFirstLine         - Skip the first line before scanning.
  //   preserveLastLine      - Push the terminating line back.
  //   readLastLine          - Include the terminating line in result.
  //   skipLineComments      - Skip line comments.
  //   skipProcessing        - Disable line preprocessing for this call.
  //   context               - Name used in unterminated-block warnings.
  //   cursor                - Starting cursor for unterminated-block warnings.
  // filter - Optional Function(line) → true to break.
  //
  // Returns a String Array.
  async readLinesUntil (options = {}, filter = null) {
    const result = [];
    let restoreProcessLines = false;
    if (this.processLines && (options.skipProcessing || options.skip_processing)) {
      this.processLines = false;
      restoreProcessLines = true;
    }

    const terminator = options.terminator ?? null;
    let startCursor, breakOnBlankLines, breakOnListContinuation;
    if (terminator) {
      startCursor = options.cursor || this.cursor;
      breakOnBlankLines = false;
      breakOnListContinuation = false;
    } else {
      breakOnBlankLines = options.breakOnBlankLines || options.break_on_blank_lines || false;
      breakOnListContinuation = options.breakOnListContinuation || options.break_on_list_continuation || false;
    }

    const skipComments = options.skipLineComments || options.skip_line_comments || false;
    let lineRead = false;
    let lineRestored = false;
    let line;

    if (options.skipFirstLine || options.skip_first_line) this._shift();

    while ((line = await this.readLine()) !== undefined) {
      let shouldBreak = false;
      if (terminator) {
        shouldBreak = line === terminator;
      } else {
        if (breakOnBlankLines && line === '') {
          shouldBreak = true;
        } else if (breakOnListContinuation && lineRead && line === LIST_CONTINUATION) {
          options.preserveLastLine = options.preserve_last_line = true;
          shouldBreak = true;
        } else if (filter && filter(line)) {
          shouldBreak = true;
        }
      }

      if (shouldBreak) {
        if (options.readLastLine || options.read_last_line) result.push(line);
        if (options.preserveLastLine || options.preserve_last_line) {
          this._unshift(line);
          lineRestored = true;
        }
        break
      }

      if (!(skipComments && line.startsWith('//') && !line.startsWith('///'))) {
        result.push(line);
        lineRead = true;
      }
    }

    if (restoreProcessLines) {
      this.processLines = true;
      if (lineRestored && !terminator) this._lookAhead--;
    }

    if (terminator && terminator !== line) {
      const context = 'context' in options ? options.context : terminator;
      if (context) {
        const sc = startCursor === 'at_mark' ? this.cursorAtMark() : startCursor;
        this._logWarn(`unterminated ${context} block`, { sourceLocation: sc });
        this.unterminated = true;
      }
    }

    return result
  }

  // ── Cursor helpers ──────────────────────────────────────────────────────────

  get cursor () { return new Cursor(this.file, this._dir, this.path, this.lineno) }
  cursorAtLine (lineno) { return new Cursor(this.file, this._dir, this.path, lineno) }
  cursorAtMark () { return this._mark ? new Cursor(...this._mark) : this.cursor }
  cursorBeforeMark () {
    if (this._mark) {
      const [mFile, mDir, mPath, mLineno] = this._mark;
      return new Cursor(mFile, mDir, mPath, mLineno - 1)
    }
    return new Cursor(this.file, this._dir, this.path, this.lineno - 1)
  }
  cursorAtPrevLine () { return new Cursor(this.file, this._dir, this.path, this.lineno - 1) }

  mark () { this._mark = [this.file, this._dir, this.path, this.lineno]; }

  lineInfo () { return `${this.path}: line ${this.lineno}` }

  // Public: Returns the remaining lines in forward order (first remaining line at index 0).
  // The returned object is a mutable proxy so that element assignments like
  //   reader.lines[i] = newValue
  // are reflected back into the internal reversed stack.
  //
  // This matches the core API where `reader.lines` is a direct, mutable reference
  // to the remaining source lines.
  get lines () {
    const _l = this._lines;
    const fwd = _l.slice().reverse();
    return new Proxy(fwd, {
      set (target, prop, value) {
        target[prop] = value;
        const idx = parseInt(prop, 10);
        if (!isNaN(idx) && idx >= 0 && idx < _l.length) {
          _l[_l.length - 1 - idx] = value;
        }
        return true
      },
    })
  }

  string () { return this._lines.slice().reverse().join(LF$1) }
  source () { return this.sourceLines.join(LF$1) }

  // ── Save / restore ──────────────────────────────────────────────────────────

  save () {
    this._saved = {
      file: this.file,
      dir: this._dir,
      path: this.path,
      lineno: this.lineno,
      lines: [...this._lines],
      mark: this._mark,
      lookAhead: this._lookAhead,
      processLines: this.processLines,
      unescapeNextLine: this._unescapeNextLine,
      unterminated: this.unterminated,
    };
  }

  restoreSave () {
    if (!this._saved) return
    const s = this._saved;
    this.file = s.file;
    this._dir = s.dir;
    this.path = s.path;
    this.lineno = s.lineno;
    this._lines = s.lines;
    this._mark = s.mark;
    this._lookAhead = s.lookAhead;
    this.processLines = s.processLines;
    this._unescapeNextLine = s.unescapeNextLine;
    this.unterminated = s.unterminated;
    this._saved = null;
  }

  discardSave () { this._saved = null; }

  toString () {
    return `#<Reader {path: ${JSON.stringify(this.path)}, line: ${this.lineno}}>`
  }

  // ── Internal (inheritable) ──────────────────────────────────────────────────

  // Internal: Shift the top line off the stack and increment lineno.
  // Subclasses may override to post-process consumed lines (see PreprocessorReader).
  _shift () {
    this.lineno++;
    if (this._lookAhead > 0) this._lookAhead--;
    return this._lines.pop()
  }

  // Internal: Push a line onto the stack and decrement lineno.
  _unshift (line) {
    this.lineno--;
    this._lookAhead++;
    this._lines.push(line);
  }

  // Internal: Restore multiple lines onto the stack.
  _unshiftAll (linesToRestore) {
    this.lineno -= linesToRestore.length;
    this._lookAhead += linesToRestore.length;
    this._lines.push(...linesToRestore.slice().reverse());
  }

  // Internal: Process a line on first visit. Returns the line unmodified by
  // default; subclasses override to evaluate preprocessor directives.
  processLine (line) {
    if (this.processLines) this._lookAhead++;
    return line
  }

  // Internal: Prepare the source data into a String Array.
  // Subclasses override to add front-matter / indentation handling.
  _prepareLines (data, opts = {}) {
    const normalize = opts.normalize;
    if (normalize) {
      const trimEnd = normalize !== 'chomp';
      return Array.isArray(data)
        ? prepareSourceArray(data, trimEnd)
        : prepareSourceString(data != null ? String(data) : '', trimEnd)
    }
    if (Array.isArray(data)) return [...data]
    if (data != null) return String(data).replace(/\n$/, '').split('\n')
    return []
  }

  // ── Public API (mirrors Ruby Asciidoctor::Reader) ───────────────────────────

  getCursor ()  { return this.cursor }
  getLines ()   { return this.sourceLines }
  getString ()  { return this.source() }
  getLogger ()  { return LoggerManager.logger }
  createLogMessage (text, context = {}) {
    return Logger.AutoFormattingMessage.attach({ text, ...context })
  }

  // ── Logging helpers ─────────────────────────────────────────────────────────

  get logger () { return this._document?.logger ?? console }

  _logWarn (msg, { sourceLocation, includeLocation } = {}) {
    let text = sourceLocation ? `${sourceLocation.lineInfo}: ${msg}` : msg;
    if (includeLocation) text += ` (${includeLocation.lineInfo})`;
    this.logger.warn(text);
  }
  _logError (msg, opts = {}) {
    let text = opts.sourceLocation ? `${opts.sourceLocation.lineInfo}: ${msg}` : msg;
    if (opts.includeLocation) text += ` (${opts.includeLocation.lineInfo})`;
    this.logger.error(text);
  }
  _logInfo (msg, { sourceLocation } = {}) {
    const text = sourceLocation ? `${sourceLocation.lineInfo}: ${msg}` : msg;
    this.logger.info(text);
  }
}

// ── PreprocessorReader ────────────────────────────────────────────────────────

class PreprocessorReader extends Reader {
  constructor (document, data = null, cursor = null, opts = {}) {
    if ('skip-front-matter' in document.attributes && !('skipFrontMatter' in opts)) {
      opts = { ...opts, skipFrontMatter: true };
    }
    // Pass document in opts so that _prepareLines (called from super) can access it.
    if (!opts.document) opts = { ...opts, document };
    super(data, cursor, opts);
    this._document = document;
    this._sourcemap = document.sourcemap;
    const defaultDepth = parseInt(document.attributes['max-include-depth'] ?? 64, 10);
    this._maxdepth = defaultDepth > 0
      ? { abs: defaultDepth, curr: defaultDepth, rel: defaultDepth }
      : null;
    this.includeStack = [];
    this._includes = document.catalog.includes;
    this._skipping = false;
    this._conditionalStack = [];
    this._includeProcessorExtensions = null;
  }

  get logger () { return this._document?.logger ?? console }

  // Override: drain conditional stack at EOS; treat blank lines as lines (not as EOF).
  // peekLine() returns undefined only at true EOF; '' for blank lines.
  async hasMoreLines () { return await this.peekLine() !== undefined }
  async empty () { return await this.peekLine() === undefined }
  async eof () { return await this.empty() }


  async peekLine (direct = false) {
    const line = await super.peekLine(direct);
    if (line !== undefined) return line
    if (this.includeStack.length === 0) {
      let endCursor = null;
      this._conditionalStack = this._conditionalStack.filter((cond) => {
        const loc = cond.sourceLocation || (endCursor ??= this.cursorAtPrevLine());
        this._logError(
          `detected unterminated preprocessor conditional directive: ${cond.name}::${cond.target || ''}[${cond.expr || ''}]`,
          { sourceLocation: loc }
        );
        return false
      });
      return undefined
    }
    this._popInclude();
    return await this.peekLine(direct)
  }

  // Override: strip leading backslash from escaped directives.
  _shift () {
    if (this._unescapeNextLine) {
      this._unescapeNextLine = false;
      const line = super._shift();
      return line.slice(1)
    }
    return super._shift()
  }

  // Public: Push new source onto the reader, switching the include context.
  //
  // Returns this reader.
  pushInclude (data, file = null, path = null, lineno = 1, attributes = {}) {
    this.includeStack.push([this._lines, this.file, this._dir, this.path, this.lineno, this._maxdepth, this.processLines]);

    if ((this.file = file)) {
      this._dir = fsdirname(String(file));
      this.path = path || fsbasename(String(file));
      const fileStr = String(file);
      if ((this.processLines = Object.keys(ASCIIDOC_EXTENSIONS).some(ext => fileStr.endsWith(ext)))) {
        const key = this.path.slice(0, this.path.lastIndexOf('.'));
        this._includes[key] ??= ('partial-option' in attributes) ? null : true;
      }
    } else {
      this._dir = '.';
      this.processLines = true;
      if ((this.path = path)) {
        this._includes[rootname(this.path)] ??= ('partial-option' in attributes) ? null : true;
      } else {
        this.path = '<stdin>';
      }
    }

    this.lineno = lineno;

    if (this._maxdepth && ('depth' in attributes)) {
      const relMaxdepth = parseInt(attributes.depth, 10);
      if (relMaxdepth > 0) {
        const absMaxdepth = this._maxdepth.abs;
        let currMaxdepth = this.includeStack.length + relMaxdepth;
        let effRel = relMaxdepth;
        if (currMaxdepth > absMaxdepth) currMaxdepth = effRel = absMaxdepth;
        this._maxdepth = { abs: absMaxdepth, curr: currMaxdepth, rel: effRel };
      } else {
        this._maxdepth = { abs: this._maxdepth.abs, curr: this.includeStack.length, rel: 0 };
      }
    }

    this._lines = this._prepareLines(data, {
      include: true,
      normalize: this.processLines || 'chomp',
      indent: attributes.indent,
      skipFrontMatter: 'skip-front-matter-option' in attributes,
    });

    if (this._lines.length === 0) {
      this._popInclude();
    } else if ('leveloffset' in attributes) {
      const leveloffset = this._document.attr('leveloffset');
      const resetLine = leveloffset ? `:leveloffset: ${leveloffset}` : ':leveloffset!:';
      const setLine = `:leveloffset: ${attributes.leveloffset}`;
      // Build stack-order array: setLine at end (read first), resetLine at start (read last)
      this._lines = [resetLine, '', ...this._lines.slice().reverse(), '', setLine];
      this.lineno -= 2;
    } else {
      this._lines.reverse();
    }
    this._lookAhead = 0;
    return this
  }

  get includeDepth () { return this.includeStack.length }

  exceedsMaxDepth () {
    return this._maxdepth && this.includeStack.length >= this._maxdepth.curr && this._maxdepth.rel
  }
  exceededMaxDepth () { return this.exceedsMaxDepth() }

  hasIncludeProcessors () {
    if (this._includeProcessorExtensions === null) {
      const exts = this._document.extensions;
      if (exts && (this._includeProcessorExtensions = exts.includeProcessors?.())) return true
      this._includeProcessorExtensions = false;
    }
    return this._includeProcessorExtensions !== false
  }

  createIncludeCursor (file, path, lineno) {
    return new Cursor(String(file), fsdirname(String(file)), path, lineno)
  }

  toString () {
    return `#<PreprocessorReader {path: ${JSON.stringify(this.path)}, line: ${this.lineno}, include depth: ${this.includeStack.length}}>`
  }

  // Override: save PreprocessorReader-specific fields in addition to Reader fields.
  save () {
    super.save();
    Object.assign(this._saved, {
      maxdepth: this._maxdepth,
      skipping: this._skipping,
      conditionalStack: this._conditionalStack.map(e => ({ ...e })),
      includeStack: [...this.includeStack],
    });
  }

  // Override: also restore PreprocessorReader-specific fields.
  restoreSave () {
    if (!this._saved) return
    this._maxdepth = this._saved.maxdepth;
    this._skipping = this._saved.skipping;
    this._conditionalStack = this._saved.conditionalStack;
    this.includeStack = this._saved.includeStack;
    super.restoreSave();
  }

  // Override: add front-matter stripping and indentation adjustment.
  _prepareLines (data, opts = {}) {
    const result = super._prepareLines(data, opts);

    if (opts.skipFrontMatter) {
      const frontMatter = this._skipFrontMatter(result);
      if (frontMatter !== null && !opts.include) {
        this._document.attributes['front-matter'] = frontMatter.join(LF$1);
      }
    }

    if (opts.include) {
      if (opts.indent != null) {
        const indentVal = parseInt(opts.indent, 10) || 0;
        const tabsize = parseInt(this._document.attr('tabsize') ?? 0, 10);
        _adjustIndentation(result, indentVal, tabsize);
      }
    } else {
      while (result.length > 0 && result[result.length - 1] === '') result.pop();
    }

    return result
  }

  // Override: evaluate preprocessor directives as lines are visited.
  async processLine (line) {
    if (!this.processLines) return line

    if (line === '') {
      if (this._skipping) { super._shift(); return undefined }
      this._lookAhead++;
      return line
    }

    if (line.endsWith(']') && !line.startsWith('[') && line.includes('::')) {
      if (line.includes('if')) {
        const m = ConditionalDirectiveRx.exec(line);
        if (m) {
          const [, escape, name, target, delimiter, text] = m;
          if (escape === '\\') {
            this._unescapeNextLine = true;
            this._lookAhead++;
            return line.slice(1)
          }
          if (this._preprocessConditionalDirective(name, target || '', delimiter || null, text || null)) {
            super._shift();
            return undefined
          }
          this._lookAhead++;
          return line
        }
      }
      if (this._skipping) { super._shift(); return undefined }
      if (line.startsWith('inc') || line.startsWith('\\inc')) {
        const m = IncludeDirectiveRx.exec(line);
        if (m) {
          const [, escape, target, attrlist] = m;
          if (escape === '\\') {
            this._unescapeNextLine = true;
            this._lookAhead++;
            return line.slice(1)
          }
          if (await this._preprocessIncludeDirective(target, attrlist ?? null)) return undefined
          this._lookAhead++;
          return line
        }
      }
      this._lookAhead++;
      return line
    }

    if (this._skipping) { super._shift(); return undefined }
    this._lookAhead++;
    return line
  }

  // ── Private preprocessor logic ──────────────────────────────────────────────

  // Internal: Evaluate a conditional directive (ifdef/ifndef/ifeval/endif).
  // Returns true if the cursor should advance past this line.
  _preprocessConditionalDirective (name, target, delimiter, text) {
    const noTarget = target === '';
    if (!noTarget) target = target.toLowerCase();

    if (name === 'endif') {
      if (text) {
        this._logError(`malformed preprocessor directive - text not permitted: endif::${target}[${text}]`, { sourceLocation: this.cursor });
      } else if (this._conditionalStack.length === 0) {
        this._logError(`unmatched preprocessor directive: endif::${target}[]`, { sourceLocation: this.cursor });
      } else {
        const top = this._conditionalStack[this._conditionalStack.length - 1];
        if (noTarget || target === top.target) {
          this._conditionalStack.pop();
          this._skipping = this._conditionalStack.length === 0
            ? false
            : this._conditionalStack[this._conditionalStack.length - 1].skipping;
        } else {
          this._logError(`mismatched preprocessor directive: endif::${target}[], expected endif::${top.target || ''}[]`, { sourceLocation: this.cursor });
        }
      }
      return true
    }

    let skip;
    if (this._skipping) {
      if (name === 'ifeval') {
        if (!(noTarget && text && EvalExpressionRx.test(text.trim()))) return true
      } else if (noTarget) {
        return true
      }
      skip = false;
    } else {
      const attrs = this._document.attributes;
      if (name === 'ifdef') {
        if (noTarget) {
          this._logError(`malformed preprocessor directive - missing target: ifdef::[${text}]`, { sourceLocation: this.cursor });
          return true
        }
        skip = delimiter === ',' ? !target.split(',').some(a => a in attrs)
          : delimiter === '+' ? target.split('+').some(a => !(a in attrs))
          : !(target in attrs);
      } else if (name === 'ifndef') {
        if (noTarget) {
          this._logError(`malformed preprocessor directive - missing target: ifndef::[${text}]`, { sourceLocation: this.cursor });
          return true
        }
        skip = delimiter === ',' ? target.split(',').some(a => a in attrs)
          : delimiter === '+' ? target.split('+').every(a => a in attrs)
          : (target in attrs);
      } else if (name === 'ifeval') {
        if (!noTarget) {
          this._logError(`malformed preprocessor directive - target not permitted: ifeval::${target}[${text}]`, { sourceLocation: this.cursor });
          return true
        }
        const m = text && EvalExpressionRx.exec(text.trim());
        if (m) {
          try {
            skip = !this._evalOp(this._resolveExprVal(m[1]), m[2], this._resolveExprVal(m[3]));
          } catch { skip = true; }
        } else {
          this._logError(`malformed preprocessor directive - ${text ? 'invalid expression' : 'missing expression'}: ifeval::[${text}]`, { sourceLocation: this.cursor });
          return true
        }
      }
    }

    if (name === 'ifeval') {
      if (skip) this._skipping = true;
      this._conditionalStack.push({ name, expr: text, skip, skipping: this._skipping, sourceLocation: this._sourcemap ? this.cursor : null });
    } else if (text) {
      if (!this._skipping && !skip) {
        this.replaceNextLine(text.trimEnd());
        // Push a dummy line to stand in for the opening conditional directive
        this._lines.push('');
        if (text.startsWith('include::')) this._lookAhead--;
      }
    } else {
      if (skip) this._skipping = true;
      this._conditionalStack.push({ name, target, skip, skipping: this._skipping, sourceLocation: this._sourcemap ? this.cursor : null });
    }

    return true
  }

  // Internal: Evaluate a conditional include directive.
  // Returns true if the line under the cursor was consumed or changed.
  async _preprocessIncludeDirective (target, attrlist) {
    await _requireFsp();
    const doc = this._document;
    let expandedTarget = target;

    if (expandedTarget.includes(ATTR_REF_HEAD)) {
      const attrMissing = doc.attributes['attribute-missing'] || Compliance.attribute_missing;
      expandedTarget = doc.subAttributes(target, { attributeMissing: attrMissing === 'warn' ? 'drop-line' : attrMissing });
      if (expandedTarget === '') {
        const parsedAttrs = attrlist ? await doc.parseAttributes(attrlist, [], { subInput: true }) : {};
        if ('optional-option' in parsedAttrs) {
          this._logInfo(`optional include dropped because resolved target is blank: include::${target}[${attrlist ?? ''}]`, { sourceLocation: this.cursor });
          super._shift();
          return true
        }
        if (attrMissing === 'drop-line') {
          this._logInfo(`include dropped due to missing attribute: include::${target}[${attrlist ?? ''}]`, { sourceLocation: this.cursor });
          super._shift();
          return true
        }
        this._logWarn(`include dropped because resolved target is blank: include::${target}[${attrlist ?? ''}]`, { sourceLocation: this.cursor });
        return this.replaceNextLine(`Unresolved directive in ${this.path} - include::${target}[${attrlist ?? ''}]`)
      }
    }

    if (this.hasIncludeProcessors()) {
      const ext = this._includeProcessorExtensions.find(c => c.instance.handles(doc, expandedTarget));
      if (ext) {
        super._shift();
        const pa = attrlist ? await doc.parseAttributes(attrlist, [], { subInput: true }) : {};
        ext.processMethod(doc, this, expandedTarget, pa);
        return true
      }
    }

    if (doc.safe >= SafeMode.SECURE) {
      const lt = expandedTarget.includes(' ') ? `pass:c[${expandedTarget}]` : expandedTarget;
      const la = doc.hasAttr('compat-mode') ? (attrlist ?? '') : `role=include${attrlist ? ',' + attrlist : ''}`;
      return this.replaceNextLine(`link:${lt}[${la}]`)
    }

    if (!this._maxdepth) return undefined

    if (this.includeStack.length >= this._maxdepth.curr) {
      this._logError(`maximum include depth of ${this._maxdepth.rel} exceeded`, { sourceLocation: this.cursor });
      return undefined
    }

    const parsedAttrs = attrlist ? await doc.parseAttributes(attrlist, [], { subInput: true }) : {};
    const resolution = await this._resolveIncludePath(expandedTarget, attrlist, parsedAttrs);
    if (!Array.isArray(resolution)) return resolution
    const [incPath, targetType, relpath] = resolution;

    let incLinenos = null;
    let incTags = null;
    if (attrlist) {
      if ('lines' in parsedAttrs && parsedAttrs.lines !== '') {
        incLinenos = [];
        for (const ld of this._splitDelimitedValue(parsedAttrs.lines)) {
          if (ld.includes('..')) {
            const sep = ld.indexOf('..');
            const from = parseInt(ld.slice(0, sep), 10);
            const toStr = ld.slice(sep + 2);
            if (toStr === '' || parseInt(toStr, 10) < 0) {
              incLinenos.push(from, Infinity);
            } else {
              const to = parseInt(toStr, 10);
              for (let i = from; i <= to; i++) incLinenos.push(i);
            }
          } else {
            incLinenos.push(parseInt(ld, 10));
          }
        }
        incLinenos = incLinenos.length > 0 ? [...new Set(incLinenos)].sort((a, b) => a - b) : null;
      } else if ('tag' in parsedAttrs) {
        const tag = parsedAttrs.tag;
        if (tag && tag !== '!') incTags = tag.startsWith('!') ? { [tag.slice(1)]: false } : { [tag]: true };
      } else if ('tags' in parsedAttrs) {
        incTags = {};
        for (const td of this._splitDelimitedValue(parsedAttrs.tags)) {
          if (td && td !== '!') {
            incTags[td.startsWith('!') ? td.slice(1) : td] = !td.startsWith('!');
          }
        }
        if (Object.keys(incTags).length === 0) incTags = null;
      }
    }

    if (targetType === 'uri') {
      let uriContent;
      try {
        const response = await fetch(incPath);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        uriContent = await response.text();
        super._shift();
      } catch (err) {
        if ('optional-option' in parsedAttrs) {
          this._logInfo(`optional include dropped because include URI not readable: ${incPath}`, { sourceLocation: this.cursor });
          super._shift();
          return true
        }
        this._logError(`include URI not readable: ${incPath} (${err.message})`, { sourceLocation: this.cursor });
        return this.replaceNextLine(`Unresolved directive in ${this.path} - include::${expandedTarget}[${attrlist ?? ''}]`)
      }
      if (incLinenos) {
        const { incLines, incOffset } = this._filterLinesByLinenos(uriContent.split('\n'), incLinenos);
        if (incOffset !== null) {
          parsedAttrs['partial-option'] = '';
          this.pushInclude(incLines, incPath, relpath, incOffset, parsedAttrs);
        }
      } else if (incTags) {
        const { incLines, incOffset } = this._filterLinesByTags(uriContent.split('\n'), incPath, expandedTarget, targetType, incTags, parsedAttrs);
        if (incOffset !== null) this.pushInclude(incLines, incPath, relpath, incOffset, parsedAttrs);
      } else {
        this.pushInclude(uriContent, incPath, relpath, 1, parsedAttrs);
      }
      return true
    }

    try {
      if (incLinenos) {
        const fileLines = (await _fsp.readFile(incPath, 'utf8')).split('\n');
        super._shift();
        const { incLines, incOffset } = this._filterLinesByLinenos(fileLines, incLinenos);
        if (incOffset !== null) {
          parsedAttrs['partial-option'] = '';
          this.pushInclude(incLines, incPath, relpath, incOffset, parsedAttrs);
        }
      } else if (incTags) {
        const fileLines = (await _fsp.readFile(incPath, 'utf8')).split('\n');
        super._shift();
        const { incLines, incOffset } = this._filterLinesByTags(fileLines, incPath, expandedTarget, targetType, incTags, parsedAttrs);
        if (incOffset !== null) this.pushInclude(incLines, incPath, relpath, incOffset, parsedAttrs);
      } else {
        let incContent;
        try {
          incContent = await _fsp.readFile(incPath, 'utf8');
          super._shift();
        } catch {
          this._logError(`include ${targetType} not readable: ${incPath}`, { sourceLocation: this.cursor });
          return this.replaceNextLine(`Unresolved directive in ${this.path} - include::${expandedTarget}[${attrlist ?? ''}]`)
        }
        this.pushInclude(incContent, incPath, relpath, 1, parsedAttrs);
      }
    } catch {
      this._logError(`include ${targetType} not readable: ${incPath}`, { sourceLocation: this.cursor });
      return this.replaceNextLine(`Unresolved directive in ${this.path} - include::${expandedTarget}[${attrlist ?? ''}]`)
    }
    return true
  }

  // Internal: Check whether the current context requires browser-mode include resolution.
  // Browser mode applies when there is no Node.js fs (true browser environment) or when
  // the document base_dir is a URI (file:// or http(s)://), even in Node.js.
  _isBrowserMode () {
    if (!_fsp) return true
    const baseDir = this._document.baseDir;
    return !!baseDir && baseDir !== '.' && (baseDir.startsWith('file://') || isUriish(baseDir))
  }

  // Internal: Resolve the include target to [incPath, targetType, relpath] or a Boolean.
  async _resolveIncludePath (target, attrlist, attributes) {
    const doc = this._document;

    // Delegate to browser-specific resolution when in a URI-based or browserless environment.
    // This handles file://, http(s)://, and relative targets resolved against a URI base_dir.
    // See src/browser/reader.js for the full specification.
    if (this._isBrowserMode()) {
      const resolution = resolveBrowserIncludePath(this, target, attrlist);
      if (!Array.isArray(resolution)) return resolution
      const [incPath, relpath] = resolution;
      return [incPath, 'uri', relpath]
    }

    if (isUriish(target) || typeof this._dir !== 'string') {
      if (!doc.attr('allow-uri-read')) {
        this._logWarn(`cannot include contents of URI: ${target} (allow-uri-read attribute not enabled)`, { sourceLocation: this.cursor });
        const lt = target.includes(' ') ? `pass:c[${target}]` : target;
        const la = doc.hasAttr('compat-mode') ? (attrlist ?? '') : `role=include${attrlist ? ',' + attrlist : ''}`;
        return this.replaceNextLine(`link:${lt}[${la}]`)
      }
      return [target, 'uri', target]
    }

    const incPath = doc.normalizeSystemPath(target, this._dir, null, { targetName: 'include file' });
    if (!await fileExists(incPath)) {
      if ('optional-option' in attributes) {
        this._logInfo(`optional include dropped because include file not found: ${incPath}`, { sourceLocation: this.cursor });
        super._shift();
        return true
      }
      this._logError(`include file not found: ${incPath}`, { sourceLocation: this.cursor });
      return this.replaceNextLine(`Unresolved directive in ${this.path} - include::${target}[${attrlist ?? ''}]`)
    }
    const relpath = doc.pathResolver.relativePath(incPath, doc.baseDir);
    return [incPath, 'file', relpath]
  }

  // Internal: Pop the top include context and restore state.
  _popInclude () {
    if (this.includeStack.length === 0) return
    ;[this._lines, this.file, this._dir, this.path, this.lineno, this._maxdepth, this.processLines] = this.includeStack.pop();
    this._lookAhead = 0;
  }

  // Internal: Read lines filtered by line-number ranges.
  _filterLinesByLinenos (fileLines, incLinenos) {
    const remaining = [...incLinenos];
    const incLines = [];
    let incOffset = null;
    let selectRemaining = false;
    for (let idx = 0; idx < fileLines.length; idx++) {
      const incLineno = idx + 1;
      const l = fileLines[idx] + (idx < fileLines.length - 1 ? '\n' : '');
      if (selectRemaining || (remaining[0] === Infinity && (selectRemaining = true))) {
        incOffset ??= incLineno;
        incLines.push(l);
      } else if (remaining[0] === incLineno) {
        incOffset ??= incLineno;
        incLines.push(l);
        remaining.shift();
        if (remaining.length === 0) break
      }
    }
    return { incLines, incOffset }
  }

  // Internal: Filter lines by tag directives.
  _filterLinesByTags (fileLines, incPath, expandedTarget, targetType, incTagsIn, parsedAttrs) {
    const tags = { ...incTagsIn };
    let select, baseSelect, wildcard;
    if ('**' in tags) {
      select = baseSelect = tags['**']; delete tags['**'];
      if ('*' in tags) { wildcard = tags['*']; delete tags['*']; }
      else if (!select && Object.values(tags)[0] === false) wildcard = true;
    } else if ('*' in tags) {
      if (Object.keys(tags)[0] === '*') { select = baseSelect = !(wildcard = tags['*']); }
      else { select = baseSelect = false; wildcard = tags['*']; }
      delete tags['*'];
    } else {
      select = baseSelect = !Object.values(tags).includes(true);
    }

    const incLines = [];
    let incOffset = null;
    const tagStack = [];
    const tagsSelected = new Set();
    let activeTag = null;

    for (let idx = 0; idx < fileLines.length; idx++) {
      const incLineno = idx + 1;
      const l = fileLines[idx] + (idx < fileLines.length - 1 ? '\n' : '');
      if (l.includes('::') && l.includes('[]')) {
        const m = TagDirectiveRx.exec(l);
        if (m) {
          const [, isEnd, thisTag] = m;
          if (isEnd) {
            if (thisTag === activeTag) {
              tagStack.pop()
              ;[activeTag, select] = tagStack.length === 0 ? [null, baseSelect] : tagStack[tagStack.length - 1];
            } else if (thisTag in tags) {
              const ic = this.createIncludeCursor(incPath, expandedTarget, incLineno);
              const si = tagStack.findLastIndex(([k]) => k === thisTag);
              if (si >= 0) {
                tagStack.splice(si, 1);
                this._logWarn(`mismatched end tag (expected '${activeTag}' but found '${thisTag}') at line ${incLineno} of include ${targetType}: ${incPath}`, { sourceLocation: this.cursor, includeLocation: ic });
              } else {
                this._logWarn(`unexpected end tag '${thisTag}' at line ${incLineno} of include ${targetType}: ${incPath}`, { sourceLocation: this.cursor, includeLocation: ic });
              }
            }
          } else if (thisTag in tags) {
            if ((select = tags[thisTag])) tagsSelected.add(thisTag);
            tagStack.push([(activeTag = thisTag), select, incLineno]);
          } else if (wildcard !== undefined) {
            select = activeTag && !select ? false : wildcard;
            tagStack.push([(activeTag = thisTag), select, incLineno]);
          }
          continue
        }
      }
      if (select) { incOffset ??= incLineno; incLines.push(l); }
    }

    for (const [tagName, , tagLineno] of tagStack) {
      const ic = this.createIncludeCursor(incPath, expandedTarget, tagLineno);
      this._logWarn(`detected unclosed tag '${tagName}' starting at line ${tagLineno} of include ${targetType}: ${incPath}`, { sourceLocation: this.cursor, includeLocation: ic });
    }

    const missingTags = Object.entries(tags).filter(([, v]) => v).map(([k]) => k).filter(k => !tagsSelected.has(k));
    if (missingTags.length > 0) {
      this._logWarn(`tag${missingTags.length > 1 ? 's' : ''} '${missingTags.join(', ')}' not found in include ${targetType}: ${incPath}`, { sourceLocation: this.cursor });
    }

    if (!baseSelect || wildcard === false || Object.keys(tags).length > 0) {
      parsedAttrs['partial-option'] = '';
    }

    return { incLines, incOffset }
  }

  // Internal: Strip YAML/TOML front matter from the data Array (in-place).
  // Returns the front-matter lines, or null if no front matter was found.
  _skipFrontMatter (data, incrementLinenos = true) {
    const delim = data[0];
    if (delim !== '---' && delim !== '+++') return null
    const original = [...data];
    data.shift();
    const frontMatter = [];
    if (incrementLinenos) this.lineno++;
    let eof = false;
    while (!(eof = data.length === 0) && data[0] !== delim) {
      frontMatter.push(data.shift());
      if (incrementLinenos) this.lineno++;
    }
    if (eof) {
      data.length = 0; data.push(...original);
      if (incrementLinenos) this.lineno -= original.length;
      return null
    }
    data.shift();
    if (incrementLinenos) this.lineno++;
    return frontMatter
  }

  // Internal: Resolve the value of one side of an ifeval expression.
  _resolveExprVal (val) {
    let quoted = false;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      quoted = true;
      val = val.slice(1, val.length - 1);
    }
    if (val.includes(ATTR_REF_HEAD)) {
      val = this._document.subAttributes(val, { attributeMissing: 'drop' });
    }
    if (quoted) return val
    if (val === '') return null
    if (val === 'true') return true
    if (val === 'false') return false
    if (val.trimEnd() === '') return ' '
    if (val.includes('.')) return parseFloat(val)
    return parseInt(val, 10)
  }

  // Internal: Evaluate a binary comparison.
  _evalOp (lhs, op, rhs) {
    // Reject comparisons that mix boolean with non-boolean (invalid in Ruby — throws TypeError).
    if ((typeof lhs === 'boolean') !== (typeof rhs === 'boolean')) throw new TypeError('incompatible operand types')
    if (op === '==') return lhs === rhs
    if (op === '!=') return lhs !== rhs
    if (op === '<') return lhs < rhs
    if (op === '>') return lhs > rhs
    if (op === '<=') return lhs <= rhs
    if (op === '>=') return lhs >= rhs
    return false
  }

  // Internal: Split a delimited value on comma (if present), otherwise semicolon.
  _splitDelimitedValue (val) {
    return val.includes(',') ? val.split(',') : val.split(';')
  }
}

const reader = /*#__PURE__*/Object.freeze({
  __proto__: null,
  Cursor: Cursor,
  PreprocessorReader: PreprocessorReader,
  Reader: Reader
});

// ESM conversion of attribute_list.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby's StringScanner is reimplemented as the module-private StringScanner
//     class using JS sticky regexes (flag 'y'). The scanner caches a sticky
//     version of each RegExp on first use to avoid repeated RegExp construction.
//   - scan() returns null (not nil) on no-match; getByte() returns undefined at EOS.
//   - Ruby's boolean `false` return from parse_attribute (bare `return`) is
//     represented as `return false`.
//   - The `continue` local variable is renamed `shouldContinue` because `continue`
//     is a reserved word in JS.
//   - snake_case method names are converted to camelCase.
//   - Private methods/fields use the JS # prefix.
//   - block.apply_subs → block.applySubs (matches Substitutors mixin naming).


// ── Constants ─────────────────────────────────────────────────────────────────
const APOS = "'";
const BACKSLASH$1 = '\\';
const QUOT = '"';

// Regular expressions for detecting the boundary of a value.
// These are passed to StringScanner which converts them to sticky variants.
const BoundaryRx = {
  [QUOT]: /.*?[^\\](?=")/,
  [APOS]: /.*?[^\\](?=')/,
  ',':    /.*?(?=[ \t]*(,|$))/,
};

// Regular expressions for unescaping quoted characters.
const EscapedQuotes = {
  [QUOT]: '\\"',
  [APOS]: "\\'",
};

// Regular expressions for skipping delimiters.
const SkipRx = {
  ',': /[ \t]*(,|$)/,
};

// Attribute name: starts with a word character, followed by word chars or hyphens.
// Constructed with the 'u' flag so \p{…} Unicode properties work.
const NameRx = new RegExp(`${CG_WORD}[${CC_WORD}\\-]*`, 'u');

// Matches one or more horizontal whitespace characters.
const BlankRx = /[ \t]+/;

// ── StringScanner ─────────────────────────────────────────────────────────────
// A minimal port of Ruby's StringScanner, sufficient for AttributeList parsing.
//
// Differences from Ruby's StringScanner:
//   - getByte()  returns undefined (not nil) at end of string.
//   - scan/skip  return null/0  (not nil) on no match.
//   - Regexes are anchored at the current position via the sticky ('y') flag.
//     A sticky copy is created once per regex and cached for reuse.
//   - unscan()   reverts only the most recent getByte / scan / skip advance.
class StringScanner {
  #source
  #pos = 0
  #lastMatchLen = 0
  #stickyCache = new Map()

  constructor (source) {
    this.#source = source;
  }

  // The original source string (equivalent to Ruby scanner.string).
  get source () { return this.#source }

  // Returns true when the scan pointer is at or past the end of the string.
  eos () { return this.#pos >= this.#source.length }

  // Returns the next n characters without advancing the scan pointer.
  peek (n) { return this.#source.slice(this.#pos, this.#pos + n) }

  // Consumes and returns the next character, or undefined at EOS.
  getByte () {
    if (this.#pos >= this.#source.length) { this.#lastMatchLen = 0; return undefined }
    this.#lastMatchLen = 1;
    return this.#source[this.#pos++]
  }

  // Reverts the most recent getByte / scan / skip advance.
  unscan () {
    this.#pos -= this.#lastMatchLen;
    this.#lastMatchLen = 0;
  }

  // Advances past rx at the current position.
  // Returns the number of characters skipped, or 0 on no match.
  skip (rx) {
    const m = this.#exec(rx);
    return m ? m[0].length : 0
  }

  // Matches rx at the current position and returns the matched string,
  // or null on no match.
  scan (rx) {
    const m = this.#exec(rx);
    return m ? m[0] : null
  }

  // Internal: execute rx (as a sticky regex) at the current position.
  #exec (rx) {
    let sticky = this.#stickyCache.get(rx);
    if (!sticky) {
      const flags = rx.flags.includes('y') ? rx.flags : `${rx.flags}y`;
      sticky = new RegExp(rx.source, flags);
      this.#stickyCache.set(rx, sticky);
    }
    sticky.lastIndex = this.#pos;
    const m = sticky.exec(this.#source);
    if (!m) { this.#lastMatchLen = 0; return null }
    this.#lastMatchLen = m[0].length;
    this.#pos += m[0].length;
    return m
  }
}

// ── AttributeList ─────────────────────────────────────────────────────────────

// Public: Handles parsing AsciiDoc attribute lists into a plain object of
// key/value pairs. By default, attributes must each be separated by a comma
// and quotes may be used around the value. If a key is not detected, the value
// is assigned to a 1-based positional key. Positional attributes can be
// "rekeyed" when given a positionalAttrs array either during parsing or after.
//
// Examples
//
//   const attrlist = new AttributeList('astyle')
//   attrlist.parse()
//   // => { 1: 'astyle' }
//
//   attrlist.rekey(['style'])
//   // => { 1: 'astyle', style: 'astyle' }
//
//   const attrlist2 = new AttributeList('quote, Famous Person, Famous Book (2001)')
//   attrlist2.parse(['style', 'attribution', 'citetitle'])
//   // => { 1: 'quote', style: 'quote', 2: 'Famous Person', attribution: 'Famous Person',
//   //      3: 'Famous Book (2001)', citetitle: 'Famous Book (2001)' }
//
class AttributeList {
  #scanner
  #block
  #delimiter
  #delimiterSkipPattern
  #delimiterBoundaryPattern
  #attributes = null

  constructor (source, block = null, delimiter = ',') {
    this.#scanner = new StringScanner(source);
    this.#block = block;
    this.#delimiter = delimiter;
    this.#delimiterSkipPattern = SkipRx[delimiter];
    this.#delimiterBoundaryPattern = BoundaryRx[delimiter];
  }

  // Public: Parse the attribute list and merge the result into the given object.
  //
  // attributes     - The target plain object to update.
  // positionalAttrs - An Array of String keys to assign to positional values.
  //
  // Returns the updated attributes object.
  async parseInto (attributes, positionalAttrs = []) {
    return Object.assign(attributes, await this.parse(positionalAttrs))
  }

  // Public: Parse the attribute list and return a plain object of key/value pairs.
  //
  // Subsequent calls return the already-parsed result without re-parsing.
  //
  // positionalAttrs - An Array of String keys to assign to positional values.
  //
  // Returns a plain object of parsed attributes.
  async parse (positionalAttrs = []) {
    if (this.#attributes) return this.#attributes
    this.#attributes = {};
    let index = 0;
    while (await this.#parseAttribute(index, positionalAttrs)) {
      if (this.#scanner.eos()) break
      this.#skipDelimiter();
      index++;
    }
    return this.#attributes
  }

  // Public: Rekey the parsed positional attributes using the given key names.
  //
  // positionalAttrs - An Array of String keys to assign to positional values.
  //
  // Returns the updated attributes object.
  rekey (positionalAttrs) {
    return AttributeList.rekey(this.#attributes, positionalAttrs)
  }

  // Public: Assign String keys to the positional (numeric-keyed) values of the
  // given attributes object.
  //
  // attributes      - A plain object produced by parse().
  // positionalAttrs - An Array of String keys to assign (null entries are skipped).
  //
  // Returns the updated attributes object.
  static rekey (attributes, positionalAttrs) {
    for (let i = 0; i < positionalAttrs.length; i++) {
      const key = positionalAttrs[i];
      if (key) {
        const val = attributes[i + 1];
        if (val != null) attributes[key] = val;
      }
    }
    return attributes
  }

  // Private: Parse the next attribute starting at the given positional index.
  //
  // Returns true to continue parsing, false to stop.
  async #parseAttribute (index, positionalAttrs) {
    let shouldContinue = true;
    this.#skipBlank();
    const peeked = this.#scanner.peek(1);
    let name, value, singleQuoted;

    if (peeked === QUOT) {
      // example: "quote" || "foo
      name = this.#parseAttributeValue(this.#scanner.getByte());
    } else if (peeked === APOS) {
      // example: 'quote' || 'foo
      name = this.#parseAttributeValue(this.#scanner.getByte());
      if (!name.startsWith(APOS)) singleQuoted = true;
    } else {
      name = this.#scanName();
      const skipped = (name !== null && this.#skipBlank()) || 0;

      if (this.#scanner.eos()) {
        // Stop unless we have a name or the source ends with the delimiter
        if (!name && !this.#scanner.source.trimEnd().endsWith(this.#delimiter)) return false
        // example: quote (at eos)
        shouldContinue = false;
      } else {
        const c = this.#scanner.getByte();
        if (c === this.#delimiter) {
          // example: quote,
          this.#scanner.unscan();
        } else if (name) {
          if (c === '=') {
            // example: foo=...
            this.#skipBlank();
            const c2 = this.#scanner.getByte();
            if (c2 === QUOT) {
              // example: foo="bar" || foo="ba\"zaar" || foo="bar
              value = this.#parseAttributeValue(c2);
            } else if (c2 === APOS) {
              // example: foo='bar' || foo='ba\'zaar' || foo='ba"zaar' || foo='bar
              value = this.#parseAttributeValue(c2);
              if (!value.startsWith(APOS)) singleQuoted = true;
            } else if (c2 === this.#delimiter) {
              // example: foo=,
              value = '';
              this.#scanner.unscan();
            } else if (c2 === undefined) {
              // example: foo= (at eos)
              value = '';
            } else {
              // example: foo=bar || foo=None
              value = `${c2}${this.#scanToDelimiter() ?? ''}`;
              if (value === 'None') return true
            }
          } else {
            // example: foo bar
            name = `${name}${' '.repeat(skipped)}${c}${this.#scanToDelimiter() ?? ''}`;
          }
        } else {
          // example: =foo= || !foo
          name = `${c}${this.#scanToDelimiter() ?? ''}`;
        }
      }
    }

    if (value !== undefined) {
      // Named attribute
      if (name === 'options' || name === 'opts') {
        // example: options="opt1,opt2,opt3" || opts="opt1,opt2,opt3"
        if (value.includes(',')) {
          if (value.includes(' ')) value = value.replace(/ /g, '');
          for (const opt of value.split(',')) {
            if (opt) this.#attributes[`${opt}-option`] = '';
          }
        } else if (value) {
          this.#attributes[`${value}-option`] = '';
        }
      } else if (singleQuoted && this.#block) {
        if (name === 'title' || name === 'reftext') {
          this.#attributes[name] = value;
        } else {
          this.#attributes[name] = await this.#block.applySubs(value);
        }
      } else {
        this.#attributes[name] = value;
      }
    } else {
      // Positional attribute
      if (singleQuoted && this.#block) {
        name = await this.#block.applySubs(name);
      }
      const positionalAttrName = positionalAttrs[index];
      if (positionalAttrName && name != null) {
        this.#attributes[positionalAttrName] = name;
      }
      // QUESTION should we assign the positional key even when claimed by a positional attribute?
      this.#attributes[index + 1] = name;
    }

    return shouldContinue
  }

  // Private: Parse a quoted attribute value starting after the opening quote.
  //
  // quote - The String quote character that opened this value (QUOT or APOS).
  //
  // Returns the parsed String value (unescaped, without surrounding quotes).
  #parseAttributeValue (quote) {
    // empty quoted value: "" or ''
    if (this.#scanner.peek(1) === quote) {
      this.#scanner.getByte();
      return ''
    }
    const value = this.#scanToQuote(quote);
    if (value !== null) {
      this.#scanner.getByte(); // consume closing quote
      return value.includes(BACKSLASH$1) ? value.replaceAll(EscapedQuotes[quote], quote) : value
    }
    // no closing quote found – treat opening quote as part of the value
    return `${quote}${this.#scanToDelimiter() ?? ''}`
  }

  #skipBlank ()        { return this.#scanner.skip(BlankRx) }
  #skipDelimiter ()    { return this.#scanner.skip(this.#delimiterSkipPattern) }
  #scanName ()         { return this.#scanner.scan(NameRx) }
  #scanToDelimiter ()  { return this.#scanner.scan(this.#delimiterBoundaryPattern) }
  #scanToQuote (quote) { return this.#scanner.scan(BoundaryRx[quote]) }
}

// ESM conversion of callouts.rb

// Public: Maintains a catalog of callouts and their associations.
class Callouts {
  constructor () {
    this._lists = [];
    this._listIndex = 0;
    this.nextList();
  }

  // Public: Register a new callout for the given list item ordinal.
  //
  // liOrdinal - The 1-based Integer ordinal of the list item.
  //
  // Returns the unique String id of this callout (e.g. 'CO1-1').
  register (liOrdinal) {
    const id = this._generateNextCalloutId();
    this.currentList().push({ ordinal: parseInt(liOrdinal, 10), id });
    this._coIndex++;
    return id
  }

  // Public: Get the next callout id in document order (used during conversion).
  //
  // Returns the unique String id of the next callout, or null.
  readNextId () {
    const list = this.currentList();
    const id = this._coIndex <= list.length ? list[this._coIndex - 1].id : null;
    this._coIndex++;
    return id
  }

  // Public: Get a space-separated list of callout ids for the given list item.
  //
  // liOrdinal - The 1-based Integer ordinal of the list item.
  //
  // Returns a String of space-separated callout ids.
  calloutIds (liOrdinal) {
    const list = this.currentList();
    return list
      .filter(item => item.ordinal === liOrdinal)
      .map(item => item.id)
      .join(' ')
  }

  // Public: The current list being collected.
  //
  // Returns the Array of callout objects at the current list index.
  currentList () {
    return this._lists[this._listIndex - 1]
  }

  // Public: Advance to the next callout list in the document.
  nextList () {
    this._listIndex++;
    if (this._lists.length < this._listIndex) this._lists.push([]);
    this._coIndex = 1;
  }

  // Public: Rewind the list pointer to the beginning (switching parse → convert).
  rewind () {
    this._listIndex = 1;
    this._coIndex = 1;
  }

  _generateNextCalloutId () {
    return `CO${this._listIndex}-${this._coIndex}`
  }
}

// ESM conversion of path_resolver.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby's File::ALT_SEPARATOR / File::SEPARATOR / Dir.pwd → process.cwd() on Node.js.
//   - Ruby's Pathname#relative_path_from → manual relative-path computation.
//   - Ruby's require 'pathname' is not needed; logic is inlined.
//   - The Opal / JRuby conditional root? overloads are omitted (Node.js only).
//   - Logging mixin is applied via applyLogging() after class definition.


const DOT            = '.';
const DOT_DOT        = '..';
const DOT_SLASH      = './';
const SLASH          = '/';
const BACKSLASH      = '\\';
const DOUBLE_SLASH   = '//';
const URI_CLASSLOADER = 'uri:classloader:';
const WINDOWS_ROOT_RX = /^(?:[a-zA-Z]:)?[\\/]/;

// Public: Handles all operations for resolving, cleaning and joining paths.
class PathResolver {
  // Public: Construct a new PathResolver.
  //
  // fileSeparator - The String file separator (default: '/' or '\\' on Windows).
  // workingDir    - The String working directory (default: process.cwd()).
  constructor (fileSeparator = null, workingDir = null) {
    this.fileSeparator = fileSeparator ?? _platformSeparator();
    if (workingDir) {
      this.workingDir = this.root(workingDir) ? this.posixify(workingDir) : _expandPath$1(workingDir);
    } else {
      this.workingDir = typeof process !== 'undefined' ? process.cwd() : '/';
    }
    this._partitionPathSys = {};
    this._partitionPathWeb = {};
  }

  // Public: Check whether the specified path is an absolute path.
  //
  // Returns Boolean.
  absolutePath (path) {
    return path.startsWith(SLASH) ||
      (this.fileSeparator === BACKSLASH && WINDOWS_ROOT_RX.test(path)) ||
      UriSniffRx.test(path)
  }

  // Public: Check if the specified path is an absolute root path.
  //
  // Returns Boolean.
  root (path) {
    return this.absolutePath(path)
  }

  // Public: Determine if the path is a UNC (root) path.
  //
  // Returns Boolean.
  unc (path) {
    return path.startsWith(DOUBLE_SLASH)
  }

  // Public: Determine if the path is an absolute (root) web path.
  //
  // Returns Boolean.
  webRoot (path) {
    return path.startsWith(SLASH)
  }

  // Public: Determine whether path descends from base.
  //
  // Returns Integer offset if path descends from base, false otherwise.
  descendsFrom (path, base) {
    if (base === path) return 0
    if (base === SLASH) return path.startsWith(SLASH) ? 1 : false
    return path.startsWith(base + SLASH) ? base.length + 1 : false
  }

  // Public: Calculate the relative path to this absolute path from the specified base directory.
  //
  // Returns a String relative path, or the original path if it cannot be made relative.
  relativePath (path, base) {
    if (this.root(path)) {
      const offset = this.descendsFrom(path, base);
      if (offset !== false) return path.slice(offset)
      try {
        return _computeRelativePath(path, base)
      } catch {
        return path
      }
    }
    return path
  }

  // Public: Normalize path by converting backslashes to forward slashes.
  //
  // Returns the posixified String path.
  posixify (path) {
    if (!path) return ''
    return this.fileSeparator === BACKSLASH && path.includes(BACKSLASH)
      ? path.replace(/\\/g, SLASH)
      : path
  }

  // Alias
  posixfy (path) { return this.posixify(path) }

  // Public: Expand the path by resolving parent references (..) and removing self references (.).
  //
  // Returns the expanded String path.
  expandPath (path) {
    const [pathSegments, pathRoot] = this.partitionPath(path);
    if (path.includes(DOT_DOT)) {
      const resolved = [];
      for (const seg of pathSegments) {
        seg === DOT_DOT ? resolved.pop() : resolved.push(seg);
      }
      return this.joinPath(resolved, pathRoot)
    }
    return this.joinPath(pathSegments, pathRoot)
  }

  // Public: Partition the path into segments and a root prefix.
  //
  // path - the String path to partition
  // web  - Boolean: treat as web path (optional, default: false)
  //
  // Returns a 2-item Array [segments, root] where root may be null.
  partitionPath (path, web = false) {
    const cache = web ? this._partitionPathWeb : this._partitionPathSys;
    if (cache[path]) return cache[path]

    const posixPath = this.posixify(path);
    let root = null;

    if (web) {
      if (this.webRoot(posixPath)) {
        root = SLASH;
      } else if (posixPath.startsWith(DOT_SLASH)) {
        root = DOT_SLASH;
      }
    } else if (this.root(posixPath)) {
      if (this.unc(posixPath)) {
        root = DOUBLE_SLASH;
      } else if (posixPath.startsWith(SLASH)) {
        root = SLASH;
      } else if (posixPath.startsWith(URI_CLASSLOADER)) {
        root = URI_CLASSLOADER;
      } else {
        const extracted = this._extractUriPrefix(posixPath);
        root = Array.isArray(extracted)
          ? extracted[1]  // URL scheme, e.g. 'http://'
          : posixPath.slice(0, posixPath.indexOf(SLASH) + 1);  // Windows drive, e.g. 'C:/'
      }
    } else if (posixPath.startsWith(DOT_SLASH)) {
      root = DOT_SLASH;
    }

    let relative = root ? posixPath.slice(root.length) : posixPath;
    let segments = relative.split(SLASH).filter(s => s !== DOT && s !== '');
    // Re-add non-empty-string DOT segments removal is as above; preserve empty for UNC
    segments = relative.split(SLASH).filter(s => s !== DOT);
    // Remove any empty segments (trailing slash artifacts) except retain intent
    segments = segments.filter(s => s !== '');

    const result = [segments, root];
    cache[path] = result;
    return result
  }

  // Public: Join segments with posix separator, prepending root if provided.
  //
  // Returns the joined String path.
  joinPath (segments, root = null) {
    return root ? `${root}${segments.join(SLASH)}` : segments.join(SLASH)
  }

  // Public: Securely resolve a system path.
  //
  // target - the String target path
  // start  - the String start path (default: null)
  // jail   - the String jail path (default: null)
  // opts   - options: recover (Boolean, default: true), target_name (String)
  //
  // Returns an absolute posix String path.
  systemPath (target, start = null, jail = null, opts = {}) {
    const recover    = opts.recover !== false;
    const targetName = opts.targetName ?? opts.target_name ?? 'path';

    if (jail) {
      if (!this.root(jail)) throw new Error(`Jail is not an absolute path: ${jail}`)
      jail = this.posixify(jail);
    }

    let targetSegments;
    if (target) {
      if (this.root(target)) {
        const targetPath = this.expandPath(target);
        if (jail && this.descendsFrom(targetPath, jail) === false) {
          if (!recover) throw new SecurityError(`${targetName} ${target} is outside of jail: ${jail} (disallowed in safe mode)`)
          this.logger.warn(`${targetName} is outside of jail; recovering automatically`);
          const [ts]          = this.partitionPath(targetPath);
          const [js, jr]      = this.partitionPath(jail);
          return this.joinPath(js.concat(ts), jr)
        }
        return targetPath
      }
[targetSegments] = this.partitionPath(target);
    } else {
      targetSegments = [];
    }

    let startSegments, jailRoot, recheck;

    if (targetSegments.length === 0) {
      if (!start) {
        return jail ?? this.workingDir
      } else if (this.root(start)) {
        if (!jail) return this.expandPath(start)
        start = this.posixify(start);
      } else {
[targetSegments] = this.partitionPath(start);
        start = jail ?? this.workingDir;
      }
    } else if (!start) {
      start = jail ?? this.workingDir;
    } else if (this.root(start)) {
      if (jail) start = this.posixify(start);
    } else {
      start = `${(jail ?? this.workingDir).replace(/\/$/, '')}/${start}`;
    }

    // Check if start is within jail
    if (jail && (recheck = this.descendsFrom(start, jail) === false) && this.fileSeparator === BACKSLASH) {
      const [ss, sr] = this.partitionPath(start);
      const [js, jr] = this.partitionPath(jail);
      if (sr !== jr) {
        if (!recover) throw new SecurityError(`start path for ${targetName} ${start} refers to location outside jail root: ${jail} (disallowed in safe mode)`)
        this.logger.warn(`start path for ${targetName} is outside of jail root; recovering automatically`);
        startSegments = js;
        jailRoot      = jr;
        recheck       = false;
      } else {
[startSegments, jailRoot] = [ss, sr];
      }
    } else {
[startSegments, jailRoot] = this.partitionPath(start);
    }

    let resolvedSegments = startSegments.concat(targetSegments);

    if (resolvedSegments.includes(DOT_DOT)) {
      const unresolved = resolvedSegments;
      resolvedSegments = [];

      if (jail) {
        let jailSegments
        ;[jailSegments] = this.partitionPath(jail);
        let warned = false;
        for (const seg of unresolved) {
          if (seg === DOT_DOT) {
            if (resolvedSegments.length > jailSegments.length) {
              resolvedSegments.pop();
            } else if (recover) {
              if (!warned) {
                this.logger.warn(`${targetName} has illegal reference to ancestor of jail; recovering automatically`);
                warned = true;
              }
            } else {
              throw new SecurityError(`${targetName} ${target} refers to location outside jail: ${jail} (disallowed in safe mode)`)
            }
          } else {
            resolvedSegments.push(seg);
          }
        }
      } else {
        for (const seg of unresolved) {
          seg === DOT_DOT ? resolvedSegments.pop() : resolvedSegments.push(seg);
        }
      }
    }

    if (recheck) {
      const targetPath = this.joinPath(resolvedSegments, jailRoot);
      if (this.descendsFrom(targetPath, jail) !== false) {
        return targetPath
      } else if (recover) {
        this.logger.warn(`${targetName} is outside of jail; recovering automatically`);
        let jailSegments
        ;[jailSegments] = this.partitionPath(jail);
        return this.joinPath(jailSegments.concat(targetSegments), jailRoot)
      } else {
        throw new SecurityError(`${targetName} ${target} is outside of jail: ${jail} (disallowed in safe mode)`)
      }
    }

    return this.joinPath(resolvedSegments, jailRoot)
  }

  // Public: Resolve a web path from the target and start paths.
  //
  // target - the String target path
  // start  - the String start (parent) path (default: null)
  //
  // Returns a String path with parent references resolved and self references removed.
  webPath (target, start = null) {
    target = this.posixify(target);
    start  = this.posixify(start);

    let uriPrefix = null;
    if (start && !this.webRoot(target)) {
      const combined = `${start}${start.endsWith(SLASH) ? '' : SLASH}${target}`;
      const extracted = this._extractUriPrefix(combined);
      if (Array.isArray(extracted)) {
[target, uriPrefix] = extracted;
      } else {
        target = extracted;
      }
    }

    const [targetSegments, targetRoot] = this.partitionPath(target, true);
    const resolved = [];
    for (const seg of targetSegments) {
      if (seg === DOT_DOT) {
        if (resolved.length === 0) {
          if (!targetRoot || targetRoot === DOT_SLASH) resolved.push(seg);
        } else if (resolved[resolved.length - 1] === DOT_DOT) {
          resolved.push(seg);
        } else {
          resolved.pop();
        }
      } else {
        resolved.push(seg);
      }
    }

    let resolvedPath = this.joinPath(resolved, targetRoot);
    if (resolvedPath.includes(' ')) resolvedPath = resolvedPath.replace(/ /g, '%20');

    return uriPrefix ? `${uriPrefix}${resolvedPath}` : resolvedPath
  }

  // Internal: Extract the URI prefix from a string if it is a URI.
  //
  // Returns [string_without_prefix, prefix] Array if URI, or the original string.
  _extractUriPrefix (str) {
    if (str.includes(':')) {
      const m = str.match(UriSniffRx);
      if (m) return [str.slice(m[0].length), m[0]]
    }
    return str
  }
}

applyLogging(PathResolver.prototype);

// ── Helpers ───────────────────────────────────────────────────────────────────

function _platformSeparator () {
  if (typeof process !== 'undefined' && process.platform === 'win32') return '\\'
  return '/'
}

// Minimal expand_path for Node.js (absolute → posix string).
function _expandPath$1 (p) {
  if (typeof process !== 'undefined') {
    // Lazy import to avoid top-level await
    try {
      // eslint-disable-next-line n/no-sync
      const path = require('node:path');
      return path.resolve(p).replace(/\\/g, '/')
    } catch {}
  }
  return p
}

// Compute relative path from `base` to `target` (both absolute POSIX strings).
function _computeRelativePath (target, base) {
  const targetParts = target.split('/').filter(Boolean);
  const baseParts   = base.split('/').filter(Boolean);
  let common = 0;
  while (common < targetParts.length && common < baseParts.length && targetParts[common] === baseParts[common]) {
    common++;
  }
  const up   = baseParts.length - common;
  const down = targetParts.slice(common);
  return [...Array(up).fill('..'), ...down].join('/') || '.'
}

// Simple SecurityError class (Ruby raises SecurityError).
class SecurityError extends Error {
  constructor (msg) {
    super(msg);
    this.name = 'SecurityError';
  }
}

// ESM conversion of converter.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby module Converter → exported plain object + classes.
//   - Ruby's `include Converter` mixin → JS class extends ConverterBase or implements the interface manually.
//   - BackendTraits Ruby module → plain mixin object applied via applyBackendTraits().
//   - DefaultFactory's thread-safe synchronization → not needed in single-threaded JS.
//   - TemplateConverter / CompositeConverter autoloaded → imported lazily via dynamic import() stubs.
//   - Converter.derive_backend_traits exposed as static function.
//   - DEFAULT_EXTENSIONS / TrailingDigitsRx imported from constants/rx.


// ── BackendTraits mixin ───────────────────────────────────────────────────────
// Apply to a converter instance to give it basebackend/filetype/htmlsyntax helpers.

function applyBackendTraits (instance) {
  instance._backendTraits = null;

  instance.basebackend = function (value = null) {
    if (value) return (this._backendTraits ??= {})[`basebackend`] = value
    return this._getBackendTraits().basebackend
  };
  instance.filetype = function (value = null) {
    if (value) return (this._getBackendTraits()).filetype = value
    return this._getBackendTraits().filetype
  };
  instance.htmlsyntax = function (value = null) {
    if (value) return (this._getBackendTraits()).htmlsyntax = value
    return this._getBackendTraits().htmlsyntax
  };
  instance.outfilesuffix = function (value = null) {
    if (value) return (this._getBackendTraits()).outfilesuffix = value
    return this._getBackendTraits().outfilesuffix
  };
  instance.supportsTemplates = function (value = true) {
    this._getBackendTraits().supportsTemplates = value;
  };
  instance.supportsTemplates.call = (value = true) => instance.supportsTemplates(value);
  instance.hasSupportsTemplates = function () {
    return !!this._getBackendTraits().supportsTemplates
  };
  instance.initBackendTraits = function (value = null) {
    this._backendTraits = value ?? {};
  };
  instance._getBackendTraits = function (basebackend = null) {
    return (this._backendTraits ??= deriveBackendTraits(this.backend, basebackend))
  };
  instance.backendInfo = instance._getBackendTraits;
}

// ── Converter.derive_backend_traits ──────────────────────────────────────────

function deriveBackendTraits (backend, basebackend = null) {
  if (!backend) return {}
  const base = basebackend ?? backend.replace(TrailingDigitsRx, '');
  let outfilesuffix = DEFAULT_EXTENSIONS[base];
  let filetype;
  if (outfilesuffix) {
    filetype = outfilesuffix.slice(1);
  } else {
    filetype     = base;
    outfilesuffix = `.${filetype}`;
  }
  const traits = { basebackend: base, filetype, outfilesuffix };
  if (filetype === 'html') traits.htmlsyntax = 'html';
  return traits
}

// ── normalizeConverter ────────────────────────────────────────────────────────
// Bridge a user-registered converter instance into the interface expected by
// Document._updateBackendAttributes, which requires _getBackendTraits().
//
// Supports three conventions used by user converters:
//   1. converter.backendTraits = { basebackend, outfilesuffix, filetype, htmlsyntax }
//   2. Plain properties: converter.basebackend, converter.outfilesuffix, …
//   3. Already has _getBackendTraits() (e.g. extends ConverterBase) — returned as-is.

function normalizeConverter (converter, backend) {
  if (!converter || typeof converter._getBackendTraits === 'function') return converter

  let traits = null;
  if (converter.backendTraits && typeof converter.backendTraits === 'object') {
    traits = { ...converter.backendTraits };
  } else {
    const hasPlain = converter.basebackend || converter.outfilesuffix || converter.filetype || converter.htmlsyntax;
    if (hasPlain) {
      traits = {};
      if (converter.basebackend)   traits.basebackend   = converter.basebackend;
      if (converter.outfilesuffix) traits.outfilesuffix = converter.outfilesuffix;
      if (converter.filetype)      traits.filetype      = converter.filetype;
      if (converter.htmlsyntax)    traits.htmlsyntax    = converter.htmlsyntax;
    }
  }

  // Apply the BackendTraits mixin so Document can call the standard accessor methods.
  applyBackendTraits(converter);
  if (traits) converter._backendTraits = traits;
  return converter
}

// ── CustomFactory ─────────────────────────────────────────────────────────────

let CustomFactory$1 = class CustomFactory {
  constructor (seedRegistry = null) {
    this._registry = {};
    this._catchAll = null;
    if (seedRegistry) {
      const star = seedRegistry['*'];
      delete seedRegistry['*'];
      if (star) this._catchAll = star;
      Object.assign(this._registry, seedRegistry);
    }
  }

  // Public: Register a converter class for one or more backend names.
  // backends may be passed as individual strings or as a single Array.
  register (converter, ...backends) {
    if (backends.length === 1 && Array.isArray(backends[0])) backends = backends[0];
    for (const backend of backends) {
      if (backend === '*') this._catchAll = converter;
      else this._registry[backend] = converter;
    }
  }

  // Public: Retrieve the converter class registered for the given backend.
  // Returns undefined (not null) when no match is found, mirroring the core API.
  for (backend) {
    return this._registry[backend] ?? this._catchAll ?? undefined
  }

  // Public: Create a new converter instance for the given backend (synchronous).
  // Requires the converter class to already be registered; does not support template dirs.
  createSync (backend, opts = {}) {
    let converter = this.for(backend);
    if (!converter) return null
    if (typeof converter === 'function' && converter.prototype) converter = new converter(backend, opts);
    return normalizeConverter(converter)
  }

  // Public: Create a new converter instance for the given backend.
  async create (backend, opts = {}) {
    let converter = this.for(backend);
    if (converter) {
      if (typeof converter === 'function' && converter.prototype) {
        converter = new converter(backend, opts);
      }
      const templateDirs = opts.template_dirs;
      if (templateDirs && typeof converter.hasSupportsTemplates === 'function' && converter.hasSupportsTemplates()) {
        const { CompositeConverter } = await Promise.resolve().then(function () { return composite; });
        const { TemplateConverter }  = await Promise.resolve().then(function () { return _browser_templateConverter; });
        return new CompositeConverter(backend, await TemplateConverter.create(backend, templateDirs, opts), converter, { backendTraitsSource: converter })
      }
      return converter
    }
    const templateDirs = opts.template_dirs;
    if (templateDirs) {
      const delegateBackend = opts.delegate_backend;
      if (delegateBackend) {
        let delegateConverter = this.for(delegateBackend);
        if (delegateConverter) {
          if (typeof delegateConverter === 'function' && delegateConverter.prototype) {
            delegateConverter = new delegateConverter(delegateBackend, opts);
          }
          const { CompositeConverter } = await Promise.resolve().then(function () { return composite; });
          const { TemplateConverter }  = await Promise.resolve().then(function () { return _browser_templateConverter; });
          return new CompositeConverter(backend, await TemplateConverter.create(backend, templateDirs, opts), delegateConverter, { backendTraitsSource: delegateConverter })
        }
      }
      const { TemplateConverter } = await Promise.resolve().then(function () { return _browser_templateConverter; });
      return await TemplateConverter.create(backend, templateDirs, opts)
    }
    return null
  }

  // Public: Get the registered converters map. (for testing)
  converters () {
    return { ...this._registry }
  }

  // Public: Unregister all converters.
  unregisterAll () {
    this._registry = {};
    this._catchAll = null;
  }
};

// ── DefaultFactory ────────────────────────────────────────────────────────────
// Global registry of built-in + statically registered converters.

// Static per-backend imports allow bundlers (Rollup/Vite) to inline each module.
async function _importBuiltinConverter (backend) {
  if (backend === 'html5')    return Promise.resolve().then(function () { return html5; })
  if (backend === 'docbook5') return Promise.resolve().then(function () { return docbook5; })
  if (backend === 'manpage')  return Promise.resolve().then(function () { return manpage; })
  return null
}

let DefaultFactory$1 = class DefaultFactory extends CustomFactory$1 {
  constructor () {
    super();
    this._defaultRegistry = {};  // separate from CustomFactory._registry (for unregisterAll)
  }

  register (converter, ...backends) {
    // User registrations go into _registry (CustomFactory layer) so that unregisterAll()
    // can remove them without touching the lazy-loaded built-in entries in _defaultRegistry.
    // backends may be passed as individual strings or as a single Array.
    if (backends.length === 1 && Array.isArray(backends[0])) backends = backends[0];
    for (const backend of backends) {
      if (backend === '*') this._catchAll = converter;
      else this._registry[backend] = converter;
    }
  }

  for (backend) {
    // User registrations first (_registry), then lazy-loaded built-ins (_defaultRegistry),
    // then catch-all.  Returns undefined when no match is found, mirroring the core API.
    return this._registry[backend] ?? this._defaultRegistry[backend] ?? this._catchAll ?? undefined
  }

  // Public: Return the combined registry (built-in + user-registered entries).
  getRegistry () {
    return { ...this._defaultRegistry, ...this._registry }
  }

  // Public: Return this factory (mirrors the core ConverterFactory.getDefault() API).
  getDefault () {
    return this
  }

  createSync (backend, opts = {}) {
    let converter = this._registry[backend] ?? this._defaultRegistry[backend] ?? this._catchAll;
    if (!converter) return null
    if (typeof converter === 'function' && converter.prototype) converter = new converter(backend, opts);
    return normalizeConverter(converter)
  }

  async create (backend, opts = {}) {
    let converter = this._registry[backend] ?? this._defaultRegistry[backend];
    if (!converter) {
      const mod = await _importBuiltinConverter(backend);
      if (mod) {
        converter = mod.default ?? Object.values(mod)[0];
        if (converter) this._defaultRegistry[backend] = converter;
      }
    }
    if (!converter) converter = this._catchAll;
    if (!converter) {
      const templateDirs = opts.template_dirs;
      if (templateDirs) {
        const { TemplateConverter } = await Promise.resolve().then(function () { return _browser_templateConverter; });
        return await TemplateConverter.create(backend, templateDirs, opts)
      }
      return null
    }
    if (typeof converter === 'function' && converter.prototype) {
      converter = new converter(backend, opts);
    }
    const templateDirs = opts.template_dirs;
    if (templateDirs && typeof converter.hasSupportsTemplates === 'function' && converter.hasSupportsTemplates()) {
      const { CompositeConverter } = await Promise.resolve().then(function () { return composite; });
      const { TemplateConverter }  = await Promise.resolve().then(function () { return _browser_templateConverter; });
      return new CompositeConverter(backend, await TemplateConverter.create(backend, templateDirs, opts), converter, { backendTraitsSource: converter })
    }
    return converter
  }

  unregisterAll () {
    // Keep built-in entries; clear only custom and catch-all
    this._registry  = {};
    this._catchAll  = null;
  }
};

// ── The global Converter registry ─────────────────────────────────────────────

const Converter = new DefaultFactory$1();

// Attach derive_backend_traits as a property for compatibility
Converter.deriveBackendTraits = deriveBackendTraits;

// ── Converter.Base ────────────────────────────────────────────────────────────

class ConverterBase {
  constructor (backend, opts = {}) {
    this.backend = backend;
    applyBackendTraits(this);
    applyLogging(this);
  }

  // Public: Convert a node by dispatching to a convert_<transform> method.
  //
  // node      - The AbstractNode to convert.
  // transform - String hint for which method to call (default: node.nodeName).
  // opts      - Optional hints Hash.
  //
  // Returns the String result or null.
  async convert (node, transform = null, opts = null) {
    const method = `convert_${transform ?? node.nodeName}`;
    if (typeof this[method] === 'function') {
      return opts ? this[method](node, opts) : this[method](node)
    }
    this.logger.warn(`missing convert handler for ${transform ?? node.nodeName} node in ${this.backend} backend (${this.constructor.name})`);
    return null
  }

  // Public: Report whether this converter can handle the given transform.
  handles (transform) {
    return typeof this[`convert_${transform}`] === 'function'
  }

  // Public: Convert using only content (no wrapping).
  async contentOnly (node) {
    return node.content()
  }

  // Public: Skip conversion.
  skip (_node) {}

  // Class method: Register this converter class with the global registry.
  static registerFor (...backends) {
    Converter.register(this, ...backends.map(String));
  }
}

const converter = /*#__PURE__*/Object.freeze({
  __proto__: null,
  Converter: Converter,
  ConverterBase: ConverterBase,
  CustomFactory: CustomFactory$1,
  applyBackendTraits: applyBackendTraits,
  deriveBackendTraits: deriveBackendTraits,
  normalizeConverter: normalizeConverter
});

// ESM conversion of syntax_highlighter.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby module SyntaxHighlighter used as mixin → SyntaxHighlighterBase class.
//   - Ruby module Factory → mixed into CustomFactory and DefaultFactory classes.
//   - Ruby @@registry class var → module-level _defaultRegistry Map for DefaultFactory.
//   - Ruby Mutex thread-safety → not needed in single-threaded JS.
//   - Ruby lazy require (PROVIDED map) → async dynamic import() in DefaultFactory.
//   - Ruby DefaultFactoryProxy (overrides #for with custom-first lookup) → DefaultFactory
//     already handles this with _registry (custom) checked before _defaultRegistry (built-in).
//   - Ruby module Config / register_for static helper → static registerFor() on each subclass.
//   - Ruby :symbol keys → plain strings throughout.
//   - highlightjs is always registered; coderay/pygments/rouge are Ruby-only (not ported).

// ── SyntaxHighlighterBase ─────────────────────────────────────────────────────

/**
 * Base class for syntax highlighter adapters.
 *
 * Subclasses should override the methods they need. Two usage patterns:
 * 1. Server-side highlighting: override `handlesHighlighting()` → true and `highlight()`.
 * 2. Client-side highlighting: override `hasDocinfo()` → true and `docinfo()`.
 *
 * Both patterns may also override `format()`.
 */
class SyntaxHighlighterBase {
  /**
   * @param {string} name - the name identifying this adapter
   * @param {string} [backend='html5'] - the backend name
   * @param {Object} [opts={}] - options
   */
  constructor (name, backend = 'html5', opts = {}) { // eslint-disable-line no-unused-vars
    this.name = name;
    this._preClass = name;
  }

  /**
   * Indicates whether this highlighter has docinfo markup to insert at the specified location.
   *
   * @param {string} location - the location slot ('head' or 'footer')
   * @returns {boolean} false by default; subclasses return true to enable {@link docinfo}
   */
  hasDocinfo (location) { // eslint-disable-line no-unused-vars
    return false
  }

  /**
   * Generates docinfo markup to insert at the specified location in the output document.
   *
   * @param {string} location - the location slot ('head' or 'footer')
   * @param {Document} doc - the Document in which this highlighter is used
   * @param {Object} opts - options
   * @param {boolean} [opts.linkcss] - link stylesheet instead of embedding
   * @param {string} [opts.cdn_base_url] - base URL for CDN assets
   * @param {string} [opts.self_closing_tag_slash] - '/' for self-closing tags
   * @returns {string} the markup to insert
   */
  docinfo (location, doc, opts) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement docinfo() since hasDocinfo() returns true`)
  }

  /**
   * Indicates whether highlighting is handled server-side by this highlighter.
   *
   * @returns {boolean} false by default; subclasses return true to enable {@link highlight}
   */
  handlesHighlighting () {
    return false
  }

  /**
   * Highlights the specified source when this source block is being converted.
   *
   * If the source contains callout marks, the caller assumes the source remains on the same
   * lines and no closing tags are added to the end of each line. If the source gets shifted
   * by one or more lines, return a tuple of the highlighted source and the line offset.
   *
   * @param {Block} node - the source Block to highlight
   * @param {string} source - the raw source text
   * @param {string} lang - the source language (e.g. 'ruby')
   * @param {Object} opts - options
   * @param {Object} [opts.callouts] - callouts indexed by line number
   * @param {string} [opts.css_mode] - CSS mode ('class' or 'inline')
   * @param {number[]} [opts.highlight_lines] - 1-based line numbers to emphasize
   * @param {string} [opts.number_lines] - 'table' or 'inline' if lines should be numbered
   * @param {number} [opts.start_line_number] - starting line number (default: 1)
   * @param {string} [opts.style] - theme name
   * @returns {string|[string, number]} the highlighted source, or a tuple with a line offset
   */
  highlight (node, source, lang, opts) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement highlight() since handlesHighlighting() returns true`)
  }

  /**
   * Formats the highlighted source for inclusion in an HTML document.
   *
   * @param {Block} node - the source Block being processed
   * @param {string} lang - the source language (e.g. 'ruby')
   * @param {Object} opts - options
   * @param {boolean} [opts.nowrap] - disable line wrapping
   * @param {Function} [opts.transform] - called with (pre, code) attribute objects before building tags
   * @returns {string} the highlighted source wrapped in &lt;pre&gt;&lt;code&gt; tags
   */
  format (node, lang, opts) {
    const classAttrVal = opts.nowrap
      ? `${this._preClass} highlight nowrap`
      : `${this._preClass} highlight`;
    const transform = opts.transform;
    if (transform) {
      const pre  = { class: classAttrVal };
      const code = lang ? { 'data-lang': lang } : {};
      transform(pre, code);
      // NOTE keep data-lang as the last attribute on <code> to match Ruby 1.5.x behaviour
      const dataLang = code['data-lang'];
      delete code['data-lang'];
      if (dataLang) code['data-lang'] = dataLang;
      const preAttrs  = Object.entries(pre).map(([k, v]) => ` ${k}="${v}"`).join('');
      const codeAttrs = Object.entries(code).map(([k, v]) => ` ${k}="${v}"`).join('');
      return `<pre${preAttrs}><code${codeAttrs}>${node.content}</code></pre>`
    }
    return `<pre class="${classAttrVal}"><code${lang ? ` data-lang="${lang}"` : ''}>${node.content}</code></pre>`
  }

  /**
   * Indicates whether this highlighter wants to write a stylesheet to disk.
   *
   * @param {Document} doc - the Document in which this highlighter is being used
   * @returns {boolean} false by default; subclasses return true to enable {@link writeStylesheetToDisk}
   */
  writeStylesheet (doc) { // eslint-disable-line no-unused-vars
    return false
  }

  /**
   * Writes the stylesheet to disk.
   *
   * @param {Document} doc - the Document in which this highlighter is used
   * @param {string} toDir - the absolute path of the output directory
   */
  writeStylesheetToDisk (doc, toDir) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement writeStylesheetToDisk() since writeStylesheet() returns true`)
  }
}

// ── CustomFactory ─────────────────────────────────────────────────────────────

/**
 * A syntax highlighter factory backed by a caller-supplied registry.
 */
class CustomFactory {
  /**
   * @param {Object|null} [seedRegistry=null] - initial registry entries
   */
  constructor (seedRegistry = null) {
    this._registry = seedRegistry ? { ...seedRegistry } : {};
  }

  /**
   * Associates a syntax highlighter class or instance with one or more names.
   *
   * @param {Function|SyntaxHighlighterBase} syntaxHighlighter - the class or instance to register
   * @param {...string} names - one or more names to associate
   */
  register (syntaxHighlighter, ...names) {
    for (const name of names) {
      this._registry[name] = syntaxHighlighter;
    }
  }

  /**
   * Retrieves the syntax highlighter class or instance registered for the given name.
   *
   * @param {string} name - the name to look up
   * @returns {Function|SyntaxHighlighterBase|null} the registered class or instance, or null
   */
  for (name) {
    return this._registry[name] ?? null
  }

  /**
   * Resolves a name to a syntax highlighter instance.
   *
   * @param {string} name - the name of the syntax highlighter
   * @param {string} [backend='html5'] - the backend name
   * @param {Object} [opts={}] - options passed to the constructor
   * @returns {SyntaxHighlighterBase|null} a highlighter instance, or null if not registered
   */
  create (name, backend = 'html5', opts = {}) {
    let syntaxHl = this.for(name);
    if (!syntaxHl) return null
    if (typeof syntaxHl === 'function' && syntaxHl.prototype) {
      syntaxHl = new syntaxHl(name, backend, opts);
    }
    if (!syntaxHl.name) {
      throw new Error(`${syntaxHl.constructor.name} must specify a value for 'name'`)
    }
    return syntaxHl
  }
}

// ── DefaultFactory ────────────────────────────────────────────────────────────

// Global registry that distinguishes built-in adapters (registered by the
// adapters themselves via self-registration) from custom adapters (registered
// by user code). unregisterAll() clears only the custom layer so built-ins
// remain available after a reset, mirroring Ruby's DefaultFactory behaviour.

class DefaultFactory extends CustomFactory {
  constructor () {
    super();
    // _registry (inherited) → custom registrations
    // _defaultRegistry      → built-in registrations (populated by adapters)
    this._defaultRegistry = {};
  }

  // Register into the built-in layer (called by built-in adapters).
  register (syntaxHighlighter, ...names) {
    for (const name of names) {
      this._defaultRegistry[name] = syntaxHighlighter;
    }
  }

  // Custom registrations shadow built-ins.
  for (name) {
    return this._registry[name] ?? this._defaultRegistry[name] ?? null
  }

  /**
   * Retrieves the syntax highlighter class or instance registered for the given name.
   *
   * @param {string} name - the name of the syntax highlighter to retrieve
   * @returns {Function|SyntaxHighlighterBase|undefined} the registered class or instance, or undefined
   */
  get (name) {
    return this.for(name) ?? undefined
  }

  create (name, backend = 'html5', opts = {}) {
    let syntaxHl = this.for(name);
    if (!syntaxHl) return null
    if (typeof syntaxHl === 'function' && syntaxHl.prototype) {
      syntaxHl = new syntaxHl(name, backend, opts);
    }
    if (!syntaxHl.name) {
      throw new Error(`${syntaxHl.constructor.name} must specify a value for 'name'`)
    }
    return syntaxHl
  }

  /**
   * Clears all custom (user) registrations; built-in adapters are preserved.
   */
  unregisterAll () {
    this._registry = {};
  }
}

// ── The global SyntaxHighlighter registry ─────────────────────────────────────

const SyntaxHighlighter = new DefaultFactory();

// ESM conversion of document.rb
//
// Ruby-to-JavaScript notes:
//   - Document extends AbstractBlock with super(self, 'document').
//   - Ruby Struct → plain class with named properties.
//   - Ruby `parse unless @parsed` → synchronous call since JS parse is synchronous.
//   - Extensions / SyntaxHighlighter are optional and loaded lazily.
//   - File.write / process.env / Time.now have Node.js equivalents.
//   - Mutex / thread-safety not applicable in single-threaded JS.
//   - `instance_variable_get :@attribute_overrides` → direct property access.


// ── Helper structs ────────────────────────────────────────────────────────────

class ImageReference {
  constructor (target, imagesdir) {
    this.target    = target;
    this.imagesdir = imagesdir;
  }
  toString () { return this.target }
}

class Footnote {
  constructor (index, id, text) {
    this.index = index;
    this.id    = id ?? null;
    this.text  = text;
  }
}

class AttributeEntry {
  constructor (name, value, negate = null) {
    this.name  = name;
    this.value = value;
    this.negate = negate == null ? value == null : negate;
  }

  saveTo (blockAttributes) {
    (blockAttributes.attribute_entries ??= []).push(this);
    return this
  }
}

// Public: Parsed and stores a partitioned title (title & subtitle).
class DocumentTitle {
  constructor (val, opts = {}) {
    this._sanitized = !!(opts.sanitize && val.includes('<'));
    if (this._sanitized) {
      val = val.replace(XmlSanitizeRx, '').replace(/  +/g, ' ').trim();
    }
    const sep = opts.separator ?? ':';
    const sepStr = sep ? `${sep} ` : null;
    if (!sepStr || !val.includes(sepStr)) {
      this.main     = val;
      this.subtitle = null;
    } else {
      const idx = val.lastIndexOf(sepStr);
      this.main     = val.slice(0, idx);
      this.subtitle = val.slice(idx + sepStr.length);
    }
    this.combined = val;
  }

  get title () { return this.main }

  isSanitized ()  { return this._sanitized }
  hasSubtitle ()  { return this.subtitle != null }
  toString ()     { return this.combined }
}

// Public: Represents an Author parsed from document attributes.
class Author {
  constructor (name, firstname, middlename, lastname, initials, email) {
    this.name       = name;
    this.firstname  = firstname;
    this.middlename = middlename;
    this.lastname   = lastname;
    this.initials   = initials;
    this.email      = email;
  }
}

// ── Document ──────────────────────────────────────────────────────────────────

class Document extends AbstractBlock {
  // Override AbstractNode's getter so Document can own its converter directly.
  get converter () { return this._converter }
  set converter (v) { this._converter = v; }

  constructor (data = null, options = {}) {
    // Bootstrap: call super with a temporary placeholder — we'll fix parent ref below.
    // AbstractBlock(parent, context, opts) — we pass `null` and patch afterward.
    super(null, 'document', options);
    // Document is its own parent/document.
    this.parent   = this;
    this.document = this;

    const parentDoc = options.parent ?? null;
    delete options.parent;

    // ── Nested document setup ─────────────────────────────────────────────────
    if (parentDoc) {
      this.parentDocument = parentDoc;
      options.base_dir ??= parentDoc.baseDir;
      if (parentDoc.options.catalog_assets) options.catalog_assets = true;
      if (parentDoc.options.to_dir) options.to_dir = parentDoc.options.to_dir;

      this.catalog = { ...parentDoc.catalog, footnotes: [] };

      // Clone parent's attribute overrides merged with parent attributes
      this._attributeOverrides = { ...parentDoc._attributeOverrides, ...parentDoc.attributes };
      const attrOverrides = this._attributeOverrides;
      delete attrOverrides['compat-mode'];
      const parentDoctype = attrOverrides['doctype']; delete attrOverrides['doctype'];
      delete attrOverrides['notitle'];
      delete attrOverrides['showtitle'];
      delete attrOverrides['toc'];
      this.attributes['toc-placement'] = attrOverrides['toc-placement'] ?? 'auto'; delete attrOverrides['toc-placement'];
      delete attrOverrides['toc-position'];

      this.safe          = parentDoc.safe;
      this.compatMode    = parentDoc.compatMode;
      if (this.compatMode) this.attributes['compat-mode'] = '';
      this.outfilesuffix = parentDoc.outfilesuffix;
      this.sourcemap     = parentDoc.sourcemap;
      this._timings      = null;
      this.pathResolver  = parentDoc.pathResolver;
      this.converter     = parentDoc.converter;
      this.extensions    = parentDoc.extensions;
      this.syntaxHighlighter = parentDoc.syntaxHighlighter;
      this._initializeExtensions = null;

      // For nested: re-use parent's @_parentDoctype
      this._parentDoctype = parentDoctype;
    } else {
      // ── Root document setup ───────────────────────────────────────────────
      this.parentDocument = null;
      this.catalog = {
        ids: {},         // deprecated
        refs: {},
        footnotes: [],
        links: [],
        images: [],
        callouts: new Callouts(),
        includes: {},
      };

      // Process attribute overrides from options
      this._attributeOverrides = {};
      const attrOverrides = this._attributeOverrides;
      for (let [key, val] of Object.entries(options.attributes ?? {})) {
        if (key.endsWith('@')) {
          if (key.startsWith('!')) {
            key = key.slice(1, -1);
            val = false;
          } else if (key.endsWith('!@')) {
            key = key.slice(0, -2);
            val = false;
          } else {
            key = key.slice(0, -1);
            val = `${val}@`;
          }
        } else if (key.startsWith('!')) {
          key = key.slice(1);
          val = val === '@' ? false : null;
        } else if (key.endsWith('!')) {
          key = key.slice(0, -1);
          val = val === '@' ? false : null;
        }
        attrOverrides[key.toLowerCase()] = val;
      }

      if (typeof options.to_file === 'string') {
        attrOverrides['outfilesuffix'] = extname(options.to_file);
      }

      // Resolve safe mode
      const safeMode = options.safe;
      if (!safeMode) {
        this.safe = SafeMode.SECURE;
      } else if (typeof safeMode === 'number') {
        this.safe = safeMode;
      } else {
        this.safe = SafeMode.valueForName(safeMode) ?? SafeMode.SECURE;
      }

      this._inputMtime     = options.input_mtime ?? null;
      delete options.input_mtime;
      this.compatMode      = 'compat-mode' in attrOverrides;
      this.sourcemap       = options.sourcemap ?? false;
      this._timings        = options.timings ?? null;
      delete options.timings;
      this.pathResolver    = new PathResolver();
      this.extensions      = options.extension_registry ?? null;
      // If no explicit registry but global extension groups are registered, activate them.
      if (!this.extensions) {
        const extsMod = await_require('./extensions.js');
        if (extsMod.Extensions) {
          const globalGroups = extsMod.Extensions.groups();
          if (Object.keys(globalGroups).length > 0) {
            this.extensions = new extsMod.Registry();
            this.extensions.activate(this);
          }
        }
      }
      this.syntaxHighlighter = null;
      this._initializeExtensions = true;  // set to class if available
      this._parentDoctype  = null;

      // Normalize :header_footer → :standalone
      if ('header_footer' in options && !('standalone' in options)) {
        options.standalone = options.header_footer;
      }
    }

    this._parsed          = false;
    this._reftexts        = null;
    this.header           = null;
    this._headerAttributes = null;
    this._counters        = {};
    this._attributesModified = new Set();
    this._docinfoProcessorExtensions = {};
    const standalone      = options.standalone ?? false;
    this.options          = Object.freeze({ ...options });

    const attrs = this.attributes;

    if (!parentDoc) {
      attrs['attribute-undefined'] = Compliance.attributeUndefined;
      attrs['attribute-missing']   = Compliance.attributeMissing;
      Object.assign(attrs, DEFAULT_ATTRIBUTES);
    }

    if (standalone) {
      delete (this._attributeOverrides)['embedded'];
      attrs['copycss']        = '';
      attrs['iconfont-remote'] = '';
      attrs['stylesheet']     = '';
      attrs['webfonts']       = '';
    } else {
      this._attributeOverrides['embedded'] = '';
      const ao = this._attributeOverrides;
      const showtitle = ao['showtitle'];
      const notitle   = ao['notitle'];
      if ('showtitle' in ao && ['showtitle', 'notitle'].filter(k => k in ao).pop() === 'showtitle') {
        ao['notitle'] = { null: '', false: '@', '@': false }[showtitle];
      } else if ('notitle' in ao) {
        ao['showtitle'] = { null: '', false: '@', '@': false }[notitle];
      } else {
        attrs['notitle'] = '';
      }
    }

    const attrOverrides = this._attributeOverrides;
    attrOverrides['asciidoctor']         = '';
    attrOverrides['asciidoctor-version'] = '3.0.0.dev';  // matches Ruby VERSION

    const safeModeName = SafeMode.nameForValue(this.safe);
    attrOverrides['safe-mode-name']              = safeModeName;
    attrOverrides[`safe-mode-${safeModeName}`]   = '';
    attrOverrides['safe-mode-level']             = this.safe;
    attrOverrides['max-include-depth']           ??= 64;
    attrOverrides['allow-uri-read']              ??= null;

    // Remap legacy attributes
    if ('numbered' in attrOverrides) {
      const _v = attrOverrides['numbered']; delete attrOverrides['numbered']; attrOverrides['sectnums'] = _v;
    }
    if ('hardbreaks' in attrOverrides) {
      const _v = attrOverrides['hardbreaks']; delete attrOverrides['hardbreaks']; attrOverrides['hardbreaks-option'] = _v;
    }

    // Resolve base_dir
    if (options.base_dir) {
      this.baseDir = attrOverrides['docdir'] = _expandPath(options.base_dir);
    } else if (attrOverrides['docdir']) {
      this.baseDir = attrOverrides['docdir'];
    } else {
      this.baseDir = attrOverrides['docdir'] = _cwd();
    }

    if (options.backend)  attrOverrides['backend']  = String(options.backend);
    if (options.doctype)  attrOverrides['doctype']  = String(options.doctype);

    if (this.safe >= SafeMode.SERVER) {
      attrOverrides['copycss']            ??= null;
      attrOverrides['source-highlighter'] ??= null;
      attrOverrides['backend']            ??= DEFAULT_BACKEND;
      if (!parentDoc && 'docfile' in attrOverrides) {
        const docdir = attrOverrides['docdir'] ?? '';
        attrOverrides['docfile'] = attrOverrides['docfile'].slice(docdir.length + 1);
      }
      attrOverrides['docdir']    = '';
      attrOverrides['user-home'] ??= '.';
      if (this.safe >= SafeMode.SECURE) {
        if (!('max-attribute-value-size' in attrOverrides)) {
          attrOverrides['max-attribute-value-size'] = 4096;
        }
        attrOverrides['linkcss'] ??= '';
        attrOverrides['icons']   ??= null;
      }
    } else {
      attrOverrides['user-home'] ??= USER_HOME;
    }

    const sizeAttr = attrOverrides['max-attribute-value-size'] ??= null;
    this._maxAttributeValueSize = sizeAttr != null ? Math.abs(parseInt(sizeAttr, 10)) : null;

    // Apply attribute overrides — overrides that survive (non-soft) stay in attrOverrides.
    const softKeys = [];
    for (const [key, val] of Object.entries(attrOverrides)) {
      if (val != null && val !== false) {
        let effective = val;
        let isSoft = false;
        if (typeof val === 'string' && val.endsWith('@')) {
          effective = val.slice(0, -1);
          isSoft    = true;
        }
        attrs[key] = effective;
        if (isSoft) softKeys.push(key);
      } else {
        delete attrs[key];
        if (val === false) softKeys.push(key);  // false = soft-lock delete; null = hard-lock absent (stays in overrides)
      }
    }
    for (const key of softKeys) delete attrOverrides[key];

    if (parentDoc) {
      this.backend = attrs['backend'];
      const parentDoctype = this._parentDoctype;
      if ((this.doctype = attrs['doctype'] = parentDoctype) !== DEFAULT_DOCTYPE) {
        this._updateDoctypeAttributes(DEFAULT_DOCTYPE);
      }
      // Set up reader only — parsing is deferred to Document.create() / doc.parse().
      const { PreprocessorReader } = await_require('./reader.js');
      this.reader = new PreprocessorReader(this, data, options.cursor);
      if (this.sourcemap) this.sourceLocation = this.reader.cursor;
    } else {
      this.backend = null;
      let initialBackend = attrs['backend'] || DEFAULT_BACKEND;
      if (initialBackend === 'manpage') {
        this.doctype = attrs['doctype'] = attrOverrides['doctype'] = 'manpage';
      } else {
        this.doctype = (attrs['doctype'] ??= DEFAULT_DOCTYPE);
      }
      this._updateBackendAttributes(initialBackend, true);

      attrs['stylesdir'] ??= '.';
      attrs['iconsdir'] ??= `${attrs['imagesdir'] ?? './images'}/icons`;

      this._fillDatetimeAttributes(attrs, this._inputMtime);

      // Extensions initialization deferred — handle in parse()
      const { PreprocessorReader, Cursor } = await_require('./reader.js');
      this.reader = new PreprocessorReader(
        this,
        data,
        new Cursor(attrs['docfile'] ?? null, this.baseDir),
        { normalize: true }
      );
      if (this.sourcemap) this.sourceLocation = this.reader.cursor;
    }
  }

  // Public: Alias catalog as references (backwards compat).
  get references () { return this.catalog }

  // Public: Returns true if this is a nested (child) document.
  nested () { return !!this.parentDocument }

  // Public: Factory — create and fully parse a Document asynchronously.
  //
  // data    - the AsciiDoc source (String, Array, or null)
  // options - plain Object of options (default: {})
  //
  // Returns a Promise that resolves to the parsed Document.
  static async create (data, options = {}) {
    const doc = new Document(data, options);
    await doc.parse();
    return doc
  }

  // Public: Parse the AsciiDoc source.
  //
  // data - Optional replacement source data.
  //
  // Returns this Document.
  async parse (data = null) {
    if (this._parsed) return this
    const doc = this;
    if (data) {
      const { PreprocessorReader, Cursor } = await_require('./reader.js');
      this.reader = new PreprocessorReader(doc, data, new Cursor(this.attributes['docfile'] ?? null, this.baseDir), { normalize: true });
      if (this.sourcemap) this.sourceLocation = this.reader.cursor;
    }

    if (!this.parentDocument && this.extensions?.hasPreprocessors?.()) {
      for (const ext of this.extensions.preprocessors()) {
        this.reader = ext.processMethod(doc, this.reader) ?? this.reader;
      }
    }

    const { Parser } = await_require('./parser.js');
    await Parser.parse(this.reader, doc, { header_only: this.options.parse_header_only });
    this._restoreAttributes();

    if (!this.parentDocument && this.extensions?.hasTreeProcessors?.()) {
      for (const ext of this.extensions.treeProcessors()) {
        const result = ext.processMethod(doc);
        if (result instanceof Document && result !== doc) {
          return result
        }
      }
    }

    // Pre-compute all async text values (titles, list item text, cell text, reftexts)
    // so that synchronous getters work correctly during conversion.
    await this._resolveAllTexts(this);
    // Reset the footnote counter so that body-content footnotes (processed during conversion)
    // start numbering from 1, reproducing Ruby's "out of sequence" quirk: title footnotes are
    // numbered during parsing via apply_title_subs, then the counter restarts for body content.
    delete this.attributes['footnote-number'];
    delete this._counters['footnote-number'];
    // Pre-compute reftext for all registered inline anchor nodes.
    for (const ref of Object.values(this.catalog.refs)) {
      if (ref && typeof ref.precomputeReftext === 'function') {
        await ref.precomputeReftext();
      }
    }
    // Build the reftext→id lookup map so that resolveId() is synchronous.
    await this._buildReftextsMap();

    this._parsed = true;
    return doc
  }

  isParsed () { return this._parsed }

  // Public: Get the named counter and take the next number in the sequence.
  counter (name, seed = null) {
    if (this.parentDocument) return this.parentDocument.counter(name, seed)
    const isLocked = this.isAttributeLocked(name);
    let currVal = this._counters[name];
    let nextVal;
    if ((isLocked && currVal != null) || ((currVal = this.attributes[name]) != null && currVal !== '')) {
      nextVal = this._counters[name] = nextval(currVal);
    } else if (seed != null) {
      nextVal = this._counters[name] = (String(seed) === String(parseInt(seed, 10)) ? parseInt(seed, 10) : seed);
    } else {
      nextVal = this._counters[name] = 1;
    }
    if (!isLocked) this.attributes[name] = nextVal;
    return nextVal
  }

  // Public: Increment the specified counter and store it in the block's attributes.
  incrementAndStoreCounter (counterName, block) {
    return (new AttributeEntry(counterName, this.counter(counterName))).saveTo(block.attributes).value
  }

  // Deprecated alias
  counterIncrement (counterName, block) { return this.incrementAndStoreCounter(counterName, block) }

  // Public: Register a reference in the document catalog.
  register (type, value) {
    switch (type) {
      case 'ids': { // deprecated
        const id  = value[0];
        const ref = new Inline(this, 'anchor', value[1], { type: 'ref', id });
        this.catalog.refs[id] ??= ref;
        // Keep _reftexts in sync if the map was already built (post-parse registration).
        if (this._reftexts && value[1]) this._reftexts[value[1]] ??= id;
        return ref
      }
      case 'refs': {
        const id = value[0];
        if (id in this.catalog.refs) return false
        this.catalog.refs[id] = value[1];
        return true
      }
      case 'footnotes':
        this.catalog.footnotes.push(value);
        return
      default:
        if (this.options.catalog_assets) {
          const entry = type === 'images'
            ? new ImageReference(value, this.attributes['imagesdir'])
            : value;
          this.catalog[type]?.push(entry);
        }
    }
  }

  // Public: Find the first registered reference matching the given reftext.
  //
  // Returns the String ID or null.
  resolveId (text) {
    if (this._reftexts) return this._reftexts[text] ?? null
    // Fallback: scan refs synchronously (for documents not parsed via parse()).
    for (const [id, ref] of Object.entries(this.catalog.refs)) {
      const xreftext = ref.reftext ?? null;
      if (xreftext === text) return id
    }
    return null
  }

  // Internal: Build the reftext→id lookup map. Called at end of parse().
  async _buildReftextsMap () {
    this._reftexts = {};
    for (const [id, ref] of Object.entries(this.catalog.refs)) {
      const xreftext = ref.xreftext ? await ref.xreftext() : null;
      if (xreftext != null) this._reftexts[xreftext] ??= id;
    }
  }

  // Public: Check whether this Document has child Section objects.
  hasSections () { return this._nextSectionIndex > 0 }

  isMultipart () {
    if (this.doctype !== 'book') return undefined
    return this.blocks.some(b => {
      if (b.context !== 'section') return false
      if (b.level === 0) return true
      if (!b.special) return false  // break in Ruby → but some() handles this
      return false
    })
  }

  hasFootnotes () { return this.catalog.footnotes.length > 0 }
  get footnotes () { return this.catalog.footnotes }
  get callouts () { return this.catalog.callouts }

  isNested ()   { return this.parentDocument != null }
  isEmbedded () { return 'embedded' in this.attributes }
  hasExtensions () { return this.extensions != null }

  source ()      { return this.reader?.source?.() ?? null }
  sourceLines () { return this.reader?.sourceLines ?? null }

  basebackend (base) {
    return this.attributes['basebackend'] === base
  }

  // Public: Get the doctitle as a String.
  get title () { return this.doctitle() }
  set title (val) {
    let sect = this.header;
    if (!sect) {
      sect = this.header = new Section(this, 0);
      sect.sectname = 'header';
    }
    sect.title = val;
  }

  // Public: Resolve the primary title for the document.
  doctitle (opts = {}) {
    let val = this.attributes['title'];
    if (val == null) {
      const sect = this.firstSection();
      if (sect) {
        val = sect.title;
      } else if (opts.use_fallback) {
        val = this.attributes['untitled-label'];
      }
      if (val == null) return null
    }
    if (opts.partition) {
      const sep = opts.partition === true ? this.attributes['title-separator'] : opts.partition;
      return new DocumentTitle(val, { ...opts, separator: sep })
    }
    if (opts.sanitize && val.includes('<')) {
      return val.replace(XmlSanitizeRx, '').replace(/  +/g, ' ').trim()
    }
    return val
  }

  get name () { return this.doctitle() }

  xreftext (_xrefstyle = null) {
    const val = this.reftext;
    return (val && val.length > 0) ? val : this.title
  }

  get author ()  { return this.attributes['author'] ?? null }
  get revdate () { return this.attributes['revdate'] ?? null }

  authors () {
    const attrs = this.attributes;
    if (!('author' in attrs)) return []
    const list = [new Author(attrs['author'], attrs['firstname'], attrs['middlename'], attrs['lastname'], attrs['authorinitials'], attrs['email'])];
    const numAuthors = parseInt(attrs['authorcount'] ?? '0', 10);
    for (let idx = 2; idx <= numAuthors; idx++) {
      list.push(new Author(attrs[`author_${idx}`], attrs[`firstname_${idx}`], attrs[`middlename_${idx}`], attrs[`lastname_${idx}`], attrs[`authorinitials_${idx}`], attrs[`email_${idx}`]));
    }
    return list
  }

  isNotitle ()  { return 'notitle' in this.attributes }
  isNoheader () { return 'noheader' in this.attributes }
  isNofooter () { return 'nofooter' in this.attributes }

  firstSection () {
    return this.header ?? this.blocks.find(b => b.context === 'section') ?? null
  }

  hasHeader () { return this.header != null }

  // Public: Append a child Block, assigning index if it's a section.
  append (block) {
    if (block.context === 'section') this.assignNumeral(block);
    return super.append(block)
  }

  // Internal: Called by parser after parsing header, before parsing body.
  finalizeHeader (unrootedAttributes, headerValid = true) {
    this._clearPlaybackAttributes(unrootedAttributes);
    this._saveAttributes();
    if (!headerValid) unrootedAttributes['invalid-header'] = true;
    return unrootedAttributes
  }

  // Public: Replay attribute assignments from block attributes.
  playbackAttributes (blockAttributes) {
    if (!('attribute_entries' in blockAttributes)) return
    for (const entry of blockAttributes.attribute_entries) {
      if (entry.negate) {
        delete this.attributes[entry.name];
        if (entry.name === 'compat-mode') this.compatMode = false;
      } else {
        this.attributes[entry.name] = entry.value;
        if (entry.name === 'compat-mode') this.compatMode = true;
      }
    }
  }

  // Public: Restore attributes to the state saved at end of header parse.
  _restoreAttributes () {
    if (!this.parentDocument) this.catalog.callouts.rewind();
    const toRestore = this._headerAttributes;
    if (toRestore) {
      // Replicate Ruby's Hash#replace: wipe keys added after the header snapshot (e.g. counters)
      for (const key of Object.keys(this.attributes)) {
        if (!(key in toRestore)) delete this.attributes[key];
      }
      Object.assign(this.attributes, toRestore);
    }
  }

  // Public: Set the specified attribute if not locked.
  //
  // Returns the substituted value, or null if locked.
  setAttribute (name, value = '', skipSubs = false) {
    if (this.isAttributeLocked(name)) return null
    if (!skipSubs && value && value !== '') value = this._applyAttributeValueSubs(value);
    if (this._headerAttributes) {
      // Beyond the document header; only update live attributes, not the header snapshot.
      this.attributes[name] = value;
    } else {
      switch (name) {
        case 'backend':
          this._updateBackendAttributes(value, this._attributesModified.delete('htmlsyntax') && value === this.backend);
          break
        case 'doctype':
          this._updateDoctypeAttributes(value);
          break
        default:
          this.attributes[name] = value;
      }
      this._attributesModified.add(name);
    }
    return value
  }

  // Public: Delete the specified attribute if not locked.
  //
  // Returns true if deleted, false if locked.
  deleteAttribute (name) {
    if (this.isAttributeLocked(name)) return false
    delete this.attributes[name];
    this._attributesModified.add(name);
    return true
  }

  // Public: Check if the attribute is locked.
  isAttributeLocked (name) {
    return name in this._attributeOverrides
  }

  // Deprecated alias
  attributeLocked (name) { return this.isAttributeLocked(name) }

  // Public: Assign a value to the specified attribute in the document header.
  setHeaderAttribute (name, value = '', overwrite = true) {
    const target = this._headerAttributes ?? this.attributes;
    if (!overwrite && (name in target)) return false
    target[name] = value;
    return true
  }

  // Internal: Walk the block tree in document order and pre-compute the content of
  // every AsciiDoc-style table cell. Must be called AFTER parse() has finished so
  // that (a) callouts.rewind() has been called and (b) all cross-references from
  // the main document are already registered in the catalog.
  async _convertAsciiDocCells (block = this) {
    for (const child of block.blocks ?? []) {
      if (child.context === 'table') {
        for (const section of ['head', 'body', 'foot']) {
          for (const row of child.rows[section] ?? []) {
            for (const cell of row) {
              if (cell.style === 'asciidoc' && cell._innerDocument && cell._innerContent == null) {
                cell._innerContent = await cell._innerDocument.convert();
              }
            }
          }
        }
      } else {
        await this._convertAsciiDocCells(child);
      }
    }
  }

  // Public: Convert the AsciiDoc document.
  async convert (opts = {}) {
    if (this._timings) this._timings.start('convert');
    await this.parse();
    // Pre-compute AsciiDoc table cell content now that parse is done:
    // callouts are rewound and all refs are registered.
    if (!this.parentDocument) await this._convertAsciiDocCells();
    if (this.safe < SafeMode.SERVER && Object.keys(opts).length > 0) {
      if (!opts.outfile) delete this.attributes['outfile'];
      else this.attributes['outfile'] = opts.outfile;
      if (!opts.outdir) delete this.attributes['outdir'];
      else this.attributes['outdir'] = opts.outdir;
    }

    let output;
    if (this.doctype === 'inline') {
      const block = this.blocks[0] ?? this.header;
      if (block) {
        if (block.contentModel === 'compound' || block.contentModel === 'empty') {
          this.logger.warn('no inline candidate; use the inline doctype to convert a single paragraph, verbatim, or raw block');
        } else {
          output = await block.content();
        }
      }
    } else {
      let transform;
      if ('standalone' in opts) {
        transform = opts.standalone ? 'document' : 'embedded';
      } else if ('header_footer' in opts) {
        transform = opts.header_footer ? 'document' : 'embedded';
      } else {
        transform = this.options.standalone ? 'document' : 'embedded';
      }
      output = await this.converter.convert(this, transform);
    }

    if (!this.parentDocument && this.extensions?.hasPostprocessors?.()) {
      for (const ext of this.extensions.postprocessors()) {
        output = ext.processMethod(this, output);
      }
    }

    if (this._timings) this._timings.record('convert');
    return output
  }

  // Deprecated alias
  render (opts = {}) { return this.convert(opts) }

  // Public: Write output to the specified file or stream.
  async write (output, target) {
    if (this._timings) this._timings.start('write');
    if (typeof this.converter.write === 'function') {
      this.converter.write(output, target);
    } else {
      if (target && typeof target.write === 'function') {
        if (output && output.length > 0) {
          target.write(output.replace(/\n$/, ''));
          target.write(LF$1);
        }
      } else {
        try {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(target, output ?? '', 'utf8');
        } catch {}
      }
      if (this.backend === 'manpage' && typeof target === 'string' &&
          typeof this.converter.constructor?.writeAlternatePages === 'function') {
        this.converter.constructor.writeAlternatePages(this.attributes['mannames'], this.attributes['manvolnum'], target);
      }
    }
    if (this._timings) this._timings.record('write');
  }

  async content () {
    delete this.attributes['title'];
    return super.content()
  }

  // Public: Read the docinfo file(s) for inclusion in the document template.
  async docinfo (location = 'head', suffix = null) {
    let content = null;
    if (this.safe < SafeMode.SECURE) {
      const qualifier = location !== 'head' ? `-${location}` : '';
      suffix ??= this.outfilesuffix;

      let docinfo = this.attributes['docinfo'];
      if (!docinfo) {
        if ('docinfo2' in this.attributes) {
          docinfo = ['private', 'shared'];
        } else if ('docinfo1' in this.attributes) {
          docinfo = ['shared'];
        } else {
          docinfo = docinfo != null ? ['private'] : null;
        }
      } else {
        docinfo = docinfo.split(',').map(k => k.trim());
      }

      if (docinfo) {
        content = [];
        const docinfoFile = `docinfo${qualifier}${suffix}`;
        const docinfoDir  = this.attributes['docinfodir'];
        const docinfoSubs = this._resolveDocinfoSubs();

        const hasShared = docinfo.includes('shared') || docinfo.includes(`shared-${location}`);
        if (hasShared) {
          const path = this.normalizeSystemPath(docinfoFile, docinfoDir);
          const shared = await this.readAsset(path, { normalize: true });
          if (shared) content.push(await this.applySubs(shared, docinfoSubs));
        }

        const docname = this.attributes['docname'];
        const hasPrivate = docname && (docinfo.includes('private') || docinfo.includes(`private-${location}`));
        if (hasPrivate) {
          const path = this.normalizeSystemPath(`${docname}-${docinfoFile}`, docinfoDir);
          const priv = await this.readAsset(path, { normalize: true });
          if (priv) content.push(await this.applySubs(priv, docinfoSubs));
        }
      }
    }

    if (this.extensions && this._docinfoProcessors(location)) {
      const extContent = this._docinfoProcessorExtensions[location].map(ext => ext.processMethod(this)).filter(Boolean);
      return (content ?? []).concat(extContent).join(LF$1)
    }
    return content ? content.join(LF$1) : ''
  }

  _docinfoProcessors (location) {
    if (location in this._docinfoProcessorExtensions) {
      return this._docinfoProcessorExtensions[location] !== false
    }
    if (this.extensions?.hasDocinfoProcessors?.(location)) {
      const exts = this.extensions.docinfoProcessors(location);
      this._docinfoProcessorExtensions[location] = exts || false;
      return !!exts
    }
    this._docinfoProcessorExtensions[location] = false;
    return false
  }

  // ── JavaScript-style accessors ────────────────────────────────────────────────

  // Public: Get the document title with substitutions applied.
  getTitle () { return this.title }

  // Public: Set the document title.
  setTitle (val) { this.title = val; }

  // Public: Resolve the primary title for the document, optionally partitioned.
  getDoctitle (opts = {}) { return this.doctitle(opts) }
  getDocumentTitle (opts = {}) { return this.doctitle(opts) }

  // Public: Get the captioned title of this document.
  getCaptionedTitle () { return this.captionedTitle() }

  // Public: Get the doctype of this document.
  getDoctype () { return this.doctype }

  // Public: Get the backend of this document.
  getBackend () { return this.backend }

  // Public: Get the safe mode level of this document.
  getSafe () { return this.safe }

  // Public: Get the compat mode flag of this document.
  getCompatMode () { return this.compatMode }

  // Public: Get the sourcemap flag of this document.
  getSourcemap () { return this.sourcemap }

  // Public: Set the sourcemap flag of this document.
  setSourcemap (val) { this.sourcemap = val; }

  // Public: Get the outfile suffix of this document.
  getOutfilesuffix () { return this.outfilesuffix }

  // Public: Get the frozen options of this document.
  getOptions () { return this.options }

  // Public: Get the converter instance for this document.
  getConverter () { return this.converter }

  // Public: Get the source String of this document.
  getSource () { return this.source() }

  // Public: Get the source lines of this document as an Array.
  getSourceLines () { return this.sourceLines() }

  // Public: Get the reader of this document.
  getReader () { return this.reader }

  // Public: Get the footnotes registered in this document.
  getFootnotes () { return this.footnotes }

  // Public: Get the callouts registered in this document.
  getCallouts () { return this.callouts }

  // Public: Get the catalog of assets registered in this document.
  getCatalog () { return this.catalog }

  // Public: Get the counters hash for this document.
  getCounters () { return this._counters }

  // Public: Get the first author of this document.
  getAuthor () { return this.author }

  // Public: Get the extensions registry for this document.
  getExtensions () { return this.extensions }

  // Public: Get the parent document of this document, if any.
  getParentDocument () { return this.parentDocument ?? undefined }

  // Public: Get the parent node of this node.
  //
  // Always returns undefined for a root Document (Document is its own internal parent).
  getParent () { return undefined }

  // Public: Delete the specified attribute if not locked.
  //
  // name - The String attribute name to remove.
  //
  // Returns the previous value, or undefined if not present or locked.
  removeAttribute (name) {
    const prev = this.attributes[name];
    this.deleteAttribute(name);
    return prev
  }

  toString () {
    return `#<Document {doctype: '${this.doctype}', doctitle: ${JSON.stringify(this.header?.title ?? null)}, blocks: ${this.blocks.length}}>`
  }

  // ── Private methods ─────────────────────────────────────────────────────────

  // Sync version: applies only synchronous subs (specialcharacters, attributes, replacements).
  // Used by setAttribute() which must remain sync for the {set:...} inline directive path.
  // Async subs (quotes, macros, …) in pass macros are handled by _applyAttributeEntryValueSubs.
  _applyAttributeValueSubs (value) {
    const m = value.match(AttributeEntryPassMacroRx);
    if (m) {
      let result = m[2] ?? '';
      if (m[1]) {
        const subs = this.resolvePassSubs(m[1]);
        if (subs) {
          for (const sub of subs) {
            if (sub === 'specialcharacters') result = this.subSpecialchars(result);
            else if (sub === 'attributes') result = this.subAttributes(result);
            else if (sub === 'replacements') result = this.subReplacements(result);
          }
        }
      }
      return this._maxAttributeValueSize != null ? _limitBytesize(result, this._maxAttributeValueSize) : result
    }
    const result = this.applyHeaderSubs(value);
    return this._maxAttributeValueSize != null ? _limitBytesize(result, this._maxAttributeValueSize) : result
  }

  // Async version: applies all subs including async ones (quotes, macros, …).
  // Used by processAttributeEntry() which can await the result.
  async _applyAttributeEntryValueSubs (value) {
    const m = value.match(AttributeEntryPassMacroRx);
    if (m) {
      let result = m[2] ?? '';
      if (m[1]) {
        const subs = this.resolvePassSubs(m[1]);
        if (subs) result = await this.applySubs(result, subs);
      }
      return this._maxAttributeValueSize != null ? _limitBytesize(result, this._maxAttributeValueSize) : result
    }
    const result = this.applyHeaderSubs(value);
    return this._maxAttributeValueSize != null ? _limitBytesize(result, this._maxAttributeValueSize) : result
  }

  _resolveDocinfoSubs () {
    return ('docinfosubs' in this.attributes)
      ? this.resolveSubs(this.attributes['docinfosubs'], 'block', null, 'docinfo')
      : ['attributes']
  }

  // Internal: Walk the block tree and pre-compute all async text values.
  // Handles titles (AbstractBlock), list item text, table cell text, and reftexts.
  async _resolveAllTexts (block) {
    // Skip title pre-computation for blocks with an explicit empty id ([id=]).
    // In Ruby, apply_title_subs is lazy: it is never called during parsing for such
    // blocks because section.title is never accessed.  An explicit empty id is
    // distinguished by block.attributes.id === '' (the AttributeList parser preserves it).
    if (block.attributes?.id !== '') {
      await block.precomputeTitle?.();
    }
    await block.precomputeReftext?.();
    const ctx = block.context;
    if (ctx === 'dlist') {
      // dlist.blocks is an array of [[term, ...], item_or_null] pairs.
      for (const [terms, item] of (block.blocks ?? [])) {
        for (const term of (terms ?? [])) {
          await term.precomputeText?.();
          await this._resolveAllTexts(term);
        }
        if (item) {
          await item.precomputeText?.();
          await this._resolveAllTexts(item);
        }
      }
    } else if (ctx === 'table') {
      for (const row of [...(block.rows?.head ?? []), ...(block.rows?.body ?? []), ...(block.rows?.foot ?? [])]) {
        for (const cell of row) {
          await cell.precomputeText?.();
          await cell.precomputeReftext?.();
        }
      }
    } else {
      for (const child of (block.blocks ?? [])) {
        await child.precomputeText?.();
        await this._resolveAllTexts(child);
      }
    }
  }

  _createConverter (backend, delegateBackend) {
    const converterOpts = { document: this, htmlsyntax: this.attributes['htmlsyntax'] };
    const opts = this.options;
    if (opts.template_dirs || opts.template_dir) {
      converterOpts.template_dirs  = [].concat(opts.template_dirs ?? opts.template_dir);
      converterOpts.template_cache = opts.template_cache ?? true;
      converterOpts.template_engine = opts.template_engine;
      converterOpts.template_engine_options = opts.template_engine_options;
      converterOpts.eruby          = opts.eruby;
      converterOpts.safe           = this.safe;
      if (delegateBackend) converterOpts.delegate_backend = delegateBackend;
    }
    if (opts.converter) {
      return (new CustomFactory$1({ [backend]: opts.converter })).createSync(backend, converterOpts)
    }
    const factory = opts.converter_factory ?? Converter;
    return factory.createSync(backend, converterOpts)
  }

  _clearPlaybackAttributes (attributes) {
    delete attributes.attribute_entries;
  }

  _saveAttributes () {
    const attrs = this.attributes;
    if (!('doctitle' in attrs)) {
      const dt = this.doctitle();
      if (dt) attrs['doctitle'] = dt;
    }
    this.id ??= attrs['css-signature'] ?? null;

    // Handle toc / toc2
    // NOTE: delete toc/toc2 from attrs first; only re-add specific placement/position attrs
    let tocVal;
    if ('toc2' in attrs) {
      delete attrs['toc2'];
      tocVal = 'left';
    } else if ('toc' in attrs) {
      tocVal = attrs['toc'];
      delete attrs['toc'];
    }
    if (tocVal != null) {
      const tocPlacementVal = attrs['toc-placement'] ?? 'macro';
      const tocPositionVal  = (tocPlacementVal && tocPlacementVal !== 'auto') ? tocPlacementVal : attrs['toc-position'];
      if (tocVal !== '' || tocPositionVal) {
        const defaultTocPosition = 'left';
        let defaultTocClass = 'toc2';
        const position = (!tocPositionVal) ? (tocVal || defaultTocPosition) : tocPositionVal;
        attrs['toc-placement'] = 'auto';
        switch (position) {
          case 'left': case '<': case '&lt;':   attrs['toc-position'] = 'left';    break
          case 'right': case '>': case '&gt;':  attrs['toc-position'] = 'right';   break
          case 'top': case '^':                 attrs['toc-position'] = 'top';     break
          case 'bottom': case 'v':              attrs['toc-position'] = 'bottom';  break
          case 'preamble': case 'macro':
            attrs['toc-position'] = 'content';
            attrs['toc-placement'] = position;
            defaultTocClass = null;
            break
          default:
            delete attrs['toc-position'];
            defaultTocClass = null;
        }
        if (defaultTocClass) attrs['toc-class'] ??= defaultTocClass;
      }
      attrs['toc'] = '';
    }

    const iconsVal = attrs['icons'];
    if (iconsVal != null && !('icontype' in attrs)) {
      if (iconsVal !== '' && iconsVal !== 'font') {
        attrs['icons'] = '';
        if (iconsVal !== 'image') attrs['icontype'] = iconsVal;
      }
    }

    this.compatMode = 'compat-mode' in attrs;
    if (this.compatMode && 'language' in attrs) {
      attrs['source-language'] = attrs['language'];
    }

    if (!this.parentDocument) {
      const basebackend = attrs['basebackend'];
      if (basebackend === 'html') {
        const syntaxHlName = attrs['source-highlighter'];
        if (syntaxHlName && !attrs[`${syntaxHlName}-unavailable`]) {
          // SyntaxHighlighter — optional integration, handle gracefully
          try {
            const factory = this.options.syntax_highlighter_factory;
            if (factory) {
              this.syntaxHighlighter = factory.create(syntaxHlName, this.backend, { document: this });
            } else {
              this.syntaxHighlighter = SyntaxHighlighter.create(syntaxHlName, this.backend, { document: this });
            }
          } catch {}
        }
      } else if (basebackend === 'docbook') {
        if (!this.isAttributeLocked('toc') && !this._attributesModified.has('toc')) {
          attrs['toc'] = '';
        }
        if (!this.isAttributeLocked('sectnums') && !this._attributesModified.has('sectnums')) {
          attrs['sectnums'] = '';
        }
      }
      this.outfilesuffix = attrs['outfilesuffix'] ?? null;

      for (const name of FLEXIBLE_ATTRIBUTES) {
        const _fv = this._attributeOverrides[name];
        if ((name in this._attributeOverrides) && _fv != null && _fv !== false) {
          delete this._attributeOverrides[name];
        }
      }
    }

    this._headerAttributes = { ...attrs };
  }

  _fillDatetimeAttributes (attrs, inputMtime) {
    const sourceDateEpoch = typeof process !== 'undefined'
      ? process.env.SOURCE_DATE_EPOCH
      : null;
    const now = (sourceDateEpoch && sourceDateEpoch !== '')
      ? new Date(parseInt(sourceDateEpoch, 10) * 1000)
      : new Date();

    let localdate = attrs['localdate'];
    if (localdate) {
      attrs['localyear'] ??= localdate.length >= 4 ? localdate.slice(0, 4) : null;
    } else {
      localdate = attrs['localdate'] = _formatDate(now);
      attrs['localyear'] ??= String(now.getFullYear());
    }
    const localtime = (attrs['localtime'] ??= _formatTime(now));
    attrs['localdatetime'] ??= `${localdate} ${localtime}`;

    const effectiveMtime = (sourceDateEpoch && sourceDateEpoch !== '')
      ? now
      : (inputMtime instanceof Date ? inputMtime : now);

    let docdate = attrs['docdate'];
    if (docdate) {
      attrs['docyear'] ??= docdate.length >= 4 ? docdate.slice(0, 4) : null;
    } else {
      docdate = attrs['docdate'] = _formatDate(effectiveMtime);
      attrs['docyear'] ??= String(effectiveMtime.getFullYear());
    }
    const doctime = (attrs['doctime'] ??= _formatTime(effectiveMtime));
    attrs['docdatetime'] ??= `${docdate} ${doctime}`;
  }

  _updateBackendAttributes (newBackend, init = false) {
    if (!init && newBackend === this.backend) return undefined
    const currentBackend     = this.backend;
    const attrs              = this.attributes;
    const currentBasebackend = attrs['basebackend'];
    const currentDoctype     = this.doctype;

    let delegateBackend = null;
    let actualBackend   = null;
    if (newBackend.includes(':')) {
      const parts = newBackend.split(':');
      actualBackend = parts[0];
      newBackend    = parts[1];
    }
    if (newBackend.startsWith('xhtml')) {
      attrs['htmlsyntax'] = 'xml';
      newBackend = newBackend.slice(1);
    } else if (newBackend.startsWith('html')) {
      attrs['htmlsyntax'] ??= 'html';
    }
    newBackend = BACKEND_ALIASES[newBackend] ?? newBackend;
    if (actualBackend) {
      delegateBackend = newBackend;
      newBackend      = actualBackend;
    }

    if (currentDoctype) {
      if (currentBackend) {
        delete attrs[`backend-${currentBackend}`];
        delete attrs[`backend-${currentBackend}-doctype-${currentDoctype}`];
      }
      attrs[`backend-${newBackend}-doctype-${currentDoctype}`] = '';
      attrs[`doctype-${currentDoctype}`] = '';
    } else if (currentBackend) {
      delete attrs[`backend-${currentBackend}`];
    }
    attrs[`backend-${newBackend}`] = '';
    this.backend = attrs['backend'] = newBackend;

    // Create the converter (may be async in some environments; here synchronous)
    const converter = this._createConverter(newBackend, delegateBackend);
    let newBasebackend, newFiletype;

    if (converter && typeof converter._getBackendTraits === 'function') {
      newBasebackend = converter.basebackend();
      newFiletype    = converter.filetype();
      const htmlsyntax = converter.htmlsyntax();
      if (htmlsyntax) attrs['htmlsyntax'] ??= htmlsyntax;
      if (init) {
        attrs['outfilesuffix'] ??= converter.outfilesuffix();
      } else if (!this.isAttributeLocked('outfilesuffix')) {
        attrs['outfilesuffix'] = converter.outfilesuffix();
      }
    } else if (converter) {
      const traits  = deriveBackendTraits(newBackend);
      newBasebackend = traits.basebackend;
      newFiletype    = traits.filetype;
      if (init) {
        attrs['outfilesuffix'] ??= traits.outfilesuffix;
      } else if (!this.isAttributeLocked('outfilesuffix')) {
        attrs['outfilesuffix'] = traits.outfilesuffix;
      }
    } else {
      throw new Error(`asciidoctor: FAILED: missing converter for backend '${newBackend}'. Processing aborted.`)
    }
    this.converter = converter;

    const currentFiletype = attrs['filetype'];
    if (currentFiletype) delete attrs[`filetype-${currentFiletype}`];
    attrs['filetype']               = newFiletype;
    attrs[`filetype-${newFiletype}`] = '';

    const pageWidth = DEFAULT_PAGE_WIDTHS[newBasebackend];
    if (pageWidth) {
      attrs['pagewidth'] = pageWidth;
    } else {
      delete attrs['pagewidth'];
    }

    if (newBasebackend !== currentBasebackend) {
      if (currentDoctype) {
        if (currentBasebackend) {
          delete attrs[`basebackend-${currentBasebackend}`];
          delete attrs[`basebackend-${currentBasebackend}-doctype-${currentDoctype}`];
        }
        attrs[`basebackend-${newBasebackend}-doctype-${currentDoctype}`] = '';
      } else if (currentBasebackend) {
        delete attrs[`basebackend-${currentBasebackend}`];
      }
      attrs[`basebackend-${newBasebackend}`] = '';
      attrs['basebackend'] = newBasebackend;
    }
    return newBackend
  }

  _updateDoctypeAttributes (newDoctype) {
    if (!newDoctype || newDoctype === this.doctype) return undefined
    const currentBackend     = this.backend;
    const attrs              = this.attributes;
    const currentBasebackend = attrs['basebackend'];
    const currentDoctype     = this.doctype;
    if (currentDoctype) {
      delete attrs[`doctype-${currentDoctype}`];
      if (currentBackend) {
        delete attrs[`backend-${currentBackend}-doctype-${currentDoctype}`];
        attrs[`backend-${currentBackend}-doctype-${newDoctype}`] = '';
      }
      if (currentBasebackend) {
        delete attrs[`basebackend-${currentBasebackend}-doctype-${currentDoctype}`];
        attrs[`basebackend-${currentBasebackend}-doctype-${newDoctype}`] = '';
      }
    } else {
      if (currentBackend) attrs[`backend-${currentBackend}-doctype-${newDoctype}`] = '';
      if (currentBasebackend) attrs[`basebackend-${currentBasebackend}-doctype-${newDoctype}`] = '';
    }
    attrs[`doctype-${newDoctype}`] = '';
    this.doctype = attrs['doctype'] = newDoctype;
    return newDoctype
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _expandPath (p) {
  try {
    return require('node:path').resolve(p)
  } catch {
    return p
  }
}

function _cwd () {
  return typeof process !== 'undefined' ? process.cwd() : '/'
}

function _pad2 (n) { return String(n).padStart(2, '0') }

function _formatDate (d) {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`
}

function _formatTime (d) {
  const offset = -d.getTimezoneOffset();
  const sign   = offset >= 0 ? '+' : '-';
  const abs    = Math.abs(offset);
  const hh     = _pad2(Math.floor(abs / 60));
  const mm     = _pad2(abs % 60);
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())} ${offset === 0 ? 'UTC' : `${sign}${hh}${mm}`}`
}

function _limitBytesize (str, max) {
  const encoded = new TextEncoder().encode(str);
  if (encoded.length <= max) return str
  // Walk back from max to find the last complete UTF-8 character boundary.
  let end = max;
  // Back up past continuation bytes (0x80–0xBF).
  while (end > 0 && (encoded[end - 1] & 0xC0) === 0x80) end--;
  // If the byte at end-1 is a multibyte start byte, check whether its full
  // sequence fits within max.
  if (end > 0 && (encoded[end - 1] & 0x80) !== 0) {
    const b = encoded[end - 1];
    const charLen = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
    if (end - 1 + charLen > max) {
      end--; // sequence extends past max → exclude this start byte
    } else {
      end = max; // sequence fits entirely → restore max
    }
  }
  return new TextDecoder().decode(encoded.slice(0, end))
}

applyLogging(Document.prototype);

Document.Footnote = Footnote;

// Module cache populated by load.js before constructing a Document.
// Keys are bare filenames ('reader.js', 'parser.js').
const _deps = {};

// Resolve a relative path (e.g. './reader.js') to a cache key.
function _depKey (path) { return path.replace(/^\.\//, '') }

function await_require (path) { return _deps[_depKey(path)] ?? {} }

const document = /*#__PURE__*/Object.freeze({
  __proto__: null,
  AttributeEntry: AttributeEntry,
  Author: Author,
  Document: Document,
  DocumentTitle: DocumentTitle,
  Footnote: Footnote,
  ImageReference: ImageReference,
  _deps: _deps
});

// ESM conversion of substitutors.rb
// This module is intended to be mixed into Section and Block via Object.assign(Target.prototype, Substitutors)


// ── Module-level constants ────────────────────────────────────────────────────

const SPECIAL_CHARS_RX = /[<&>]/g;
const SPECIAL_CHARS_TR = { '>': '&gt;', '<': '&lt;', '&': '&amp;' };

// Detects if text is a possible candidate for the quotes substitution.
const QUOTED_TEXT_SNIFF_RX = {
  false: /[*_`#^~]/,
  true: /[*'_+#^~]/,
};

const BASIC_SUBS = Object.freeze(['specialcharacters']);
const NO_SUBS = Object.freeze([]);
const NORMAL_SUBS = Object.freeze(['specialcharacters', 'quotes', 'attributes', 'replacements', 'macros', 'post_replacements']);
const REFTEXT_SUBS = Object.freeze(['specialcharacters', 'quotes', 'replacements']);
const VERBATIM_SUBS = Object.freeze(['specialcharacters', 'callouts']);

const SUB_GROUPS = {
  none: NO_SUBS,
  normal: NORMAL_SUBS,
  verbatim: VERBATIM_SUBS,
  specialchars: BASIC_SUBS,
};

const SUB_HINTS = {
  a: 'attributes',
  m: 'macros',
  n: 'normal',
  p: 'post_replacements',
  q: 'quotes',
  r: 'replacements',
  c: 'specialcharacters',
  v: 'verbatim',
};

const SUB_OPTIONS = {
  block: [...Object.keys(SUB_GROUPS), ...NORMAL_SUBS, 'callouts'],
  inline: [...Object.keys(SUB_GROUPS), ...NORMAL_SUBS],
};

// control characters used as placeholders
const CAN = '\u0018';
const DEL = '\u007f';

// SPA, start of guarded protected area (\u0096)
const PASS_START = '\u0096';

// EPA, end of guarded protected area (\u0097)
const PASS_END = '\u0097';

// match passthrough slot
const PASS_SLOT_RX = new RegExp(`${PASS_START}(\\d+)${PASS_END}`, 'g');

// fix passthrough slot after syntax highlighting
const HIGHLIGHTED_PASS_SLOT_RX = new RegExp(
  `<span\\b[^>]*>${PASS_START}</span>[^\\d]*(\\d+)[^\\d]*<span\\b[^>]*>${PASS_END}</span>`,
  'g'
);

const RS = '\\';
const R_SB = ']';
const ESC_R_SB = '\\]';
const PLUS = '+';

/**
 * Ruby `str.partition(delim)` → `[before, delim, after]` (first occurrence).
 * Returns `[str, '', '']` when delim is not found.
 */
function partition(str, delim) {
  const idx = str.indexOf(delim);
  if (idx === -1) return [str, '', '']
  return [str.slice(0, idx), delim, str.slice(idx + delim.length)]
}

/**
 * Array union (Ruby `arr | other`).
 */
function arrayUnion(a, b) {
  const set = new Set(a);
  for (const v of b) set.add(v);
  return [...set]
}

/**
 * Array intersection (Ruby `arr & other`): elements of a that appear in b, deduplicated,
 * preserving the order from a with first occurrence winning.
 */
function arrayIntersect(a, b) {
  const allowed = new Set(b);
  const seen = new Set();
  return a.filter((v) => {
    if (!allowed.has(v) || seen.has(v)) return false
    seen.add(v);
    return true
  })
}

/**
 * Array difference (Ruby `arr - other`).
 */
function arrayDiff(a, b) {
  const set = new Set(b);
  return a.filter((v) => !set.has(v))
}

/**
 * Make a regex global if it isn't already.
 */
function globalRx(rx) {
  return rx.global ? rx : new RegExp(rx.source, rx.flags + 'g')
}

// ── Substitutors mixin ────────────────────────────────────────────────────────

const Substitutors = {
  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Apply the specified substitutions to the text.
   *
   * @param {string|string[]} text - The text to process; must not be null.
   * @param {string[]} [subs=NORMAL_SUBS] - The substitutions to perform.
   * @returns {string|string[]} Text with substitutions applied.
   */
  async applySubs(text, subs = NORMAL_SUBS) {
    const isEmpty = Array.isArray(text) ? text.length === 0 : text.length === 0;
    if (isEmpty || !subs || subs.length === 0) return text

    const isMultiline = Array.isArray(text);
    if (isMultiline) {
      text = text.length > 1 ? text.join(LF$1) : text[0];
    }

    let passthrus;
    let clearPassthrus = false;

    if (subs.includes('macros')) {
      text = this.extractPassthroughs(text);
      if (this.passthroughs.length > 0) {
        passthrus = this.passthroughs;
        // placeholders can move around; only clear in the outermost substitution call
        if (!this.passthroughsLocked) {
          this.passthroughsLocked = true;
          clearPassthrus = true;
        }
      }
    }

    for (const type of subs) {
      switch (type) {
        case 'specialcharacters':
          text = this.subSpecialchars(text);
          break
        case 'quotes':
          text = await this.subQuotes(text);
          break
        case 'attributes':
          if (text.includes(ATTR_REF_HEAD)) text = this.subAttributes(text);
          break
        case 'replacements':
          text = this.subReplacements(text);
          break
        case 'macros':
          text = await this.subMacros(text);
          break
        case 'highlight':
          text = await this.highlightSource(text, subs.includes('callouts'));
          break
        case 'callouts':
          if (!subs.includes('highlight')) text = await this.subCallouts(text);
          break
        case 'post_replacements':
          text = await this.subPostReplacements(text);
          break
        default:
          this.logger.warn(`unknown substitution type ${type}`);
      }
    }

    if (passthrus) {
      text = await this.restorePassthroughs(text);
      if (clearPassthrus) {
        passthrus.length = 0;
        this.passthroughsLocked = null;
      }
    }

    return isMultiline ? text.split(LF$1) : text
  },

  /** Apply normal substitutions (alias for applySubs with default args). */
  async applyNormalSubs(text) {
    return this.applySubs(text, NORMAL_SUBS)
  },

  /** Apply substitutions for header metadata and attribute assignments.
   * Header subs are 'specialcharacters' + 'attributes', both of which are
   * purely synchronous operations — so this method is intentionally sync
   * to allow it to be called from synchronous contexts such as setAttribute()
   * and the {set:...} directive inside subAttributes(). */
  applyHeaderSubs(text) {
    return this.subAttributes(this.subSpecialchars(text))
  },

  /** Apply substitutions for titles (alias for applySubs). */
  async applyTitleSubs(text, subs = NORMAL_SUBS) {
    return this.applySubs(text, subs)
  },

  /** Apply substitutions for reftext. */
  async applyReftextSubs(text) {
    return this.applySubs(text, REFTEXT_SUBS)
  },

  /**
   * Substitute special characters (encode XML entities).
   *
   * @param {string} text
   * @returns {string}
   */
  subSpecialchars(text) {
    if (text.includes('>') || text.includes('&') || text.includes('<')) {
      return text.replace(SPECIAL_CHARS_RX, (ch) => SPECIAL_CHARS_TR[ch])
    }
    return text
  },

  /** Alias for subSpecialchars. */
  subSpecialcharacters(text) {
    return this.subSpecialchars(text)
  },

  /**
   * Substitute quoted text (emphasis, strong, monospaced, etc.)
   *
   * @param {string} text
   * @returns {string}
   */
  async subQuotes(text) {
    const compat = this.document.compatMode;
    if (QUOTED_TEXT_SNIFF_RX[compat].test(text)) {
      for (const [type, scope, pattern] of QUOTE_SUBS[compat]) {
        text = await asyncReplace(text, globalRx(pattern), async (...args) => {
          return this.convertQuotedText(args, type, scope)
        });
      }
    }
    return text
  },

  /**
   * Substitute attribute references in the specified text.
   *
   * @param {string} text
   * @param {Object} [opts={}]
   * @returns {string}
   */
  subAttributes(text, opts = {}) {
    const docAttrs = this.document.attributes;
    let drop = false;
    let dropLine = false;
    let dropLineSeverity = null;
    let dropEmptyLine = false;
    let attributeUndefined = null;
    let attributeMissing = null;

    text = text.replace(globalRx(AttributeReferenceRx), (match, p1, p2, p3, p4) => {
      // escaped attribute → return unescaped
      if (p1 === RS || p4 === RS) {
        return `{${p2}}`
      }

      if (p3) {
        const args = p2.split(':', 3);
        const directive = args.shift();
        if (directive === 'set') {
          const [, value] = Parser.storeAttribute(args[0], args[1] || '', this.document);
          if (value !== null && value !== undefined ||
              (attributeUndefined ||= (docAttrs['attribute-undefined'] || Compliance.attributeUndefined)) !== 'drop-line') {
            drop = true;
            dropEmptyLine = true;
            return DEL
          } else {
            drop = true;
            dropLine = true;
            return CAN
          }
        } else if (directive === 'counter2') {
          this.document.counter(...args);
          drop = true;
          dropEmptyLine = true;
          return DEL
        } else {
          // 'counter'
          return this.document.counter(...args)
        }
      }

      const key = p2.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(docAttrs, key)) {
        return docAttrs[key]
      }

      const intrinsicValue = INTRINSIC_ATTRIBUTES[key];
      if (intrinsicValue !== undefined) return intrinsicValue

      switch (attributeMissing ||= (opts.attributeMissing || docAttrs['attribute-missing'] || Compliance.attributeMissing)) {
        case 'drop':
          drop = true;
          dropEmptyLine = true;
          return DEL
        case 'drop-line':
          dropLineSeverity ||= opts.dropLineSeverity || 'info';
          if (dropLineSeverity === 'info') {
            this.logger.info(`dropping line containing reference to missing attribute: ${key}`);
          }
          drop = true;
          dropLine = true;
          return CAN
        case 'warn':
          this.logger.warn(`skipping reference to missing attribute: ${key}`);
          return match
        default: // 'skip'
          return match
      }
    });

    if (drop) {
      if (dropEmptyLine) {
        const lines = text.replace(new RegExp(`${DEL}+`, 'g'), DEL).split(LF$1);
        if (dropLine) {
          return lines
            .filter((line) => line !== DEL && line !== CAN && !line.startsWith(CAN) && !line.includes(CAN))
            .join(LF$1)
            .split(DEL).join('')
        } else {
          return lines
            .filter((line) => line !== DEL)
            .join(LF$1)
            .split(DEL).join('')
        }
      } else if (text.includes(LF$1)) {
        return text.split(LF$1).filter((line) => line !== CAN && !line.startsWith(CAN) && !line.includes(CAN)).join(LF$1)
      } else {
        // When the caller sets returnDropSentinel, return null to signal that the line was
        // dropped due to a *missing* attribute (as opposed to an attribute that simply has a
        // blank value).  This lets callers distinguish the two cases without changing the
        // general contract of subAttributes for every other call-site.
        return opts.returnDropSentinel ? null : ''
      }
    }

    return text
  },

  /**
   * Substitute replacement characters (copyright, trademark, etc.)
   *
   * @param {string} text
   * @returns {string}
   */
  subReplacements(text) {
    if (ReplaceableTextRx.test(text)) {
      for (const [pattern, replacement, restore] of REPLACEMENTS) {
        text = text.replace(globalRx(pattern), (...args) => {
          return this.doReplacement(args, replacement, restore)
        });
      }
    }
    return text
  },

  /**
   * Substitute inline macros (links, images, etc.)
   *
   * @param {string} text
   * @returns {string}
   */
  async subMacros(text) {
    const foundSquareBracket = text.includes('[');
    const foundColon = text.includes(':');
    const foundMacroish = foundSquareBracket && foundColon;
    const foundMacroishShort = foundMacroish && text.includes(':[');
    const doc = this.document;
    const docAttrs = doc.attributes;

    // Extension inline macros
    const extensions = doc.extensions;
    if (extensions && extensions.inlineMacros()) {
      for (const extension of extensions.inlineMacros()) {
        text = await asyncReplace(text, globalRx(extension.instance.regexp), async (...args) => {
          const match = args[0];
          if (match.startsWith(RS)) return match.slice(1)

          const groups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
            ? args[args.length - 1]
            : null;
          let target, content;
          if (!groups || Object.keys(groups).length === 0) {
            target = args[1];
            content = args[2];
          } else {
            target = groups.target ?? null;
            content = groups.content ?? null;
          }

          const extConfig = extension.config;
          const defaultAttrs = extConfig.defaultAttrs;
          const attributes = defaultAttrs ? { ...defaultAttrs } : {};

          if (content !== null && content !== undefined) {
            if (!content) {
              if (extConfig.contentModel !== 'attributes') attributes.text = content;
            } else {
              content = this.normalizeText(content, true, true);
              if (extConfig.contentModel === 'attributes') {
                await this.parseAttributes(content, extConfig.positionalAttrs || extConfig.posAttrs || [], { into: attributes });
              } else {
                attributes.text = content;
              }
            }
            target = target ?? (extConfig.format === 'short' ? content : null);
          }

          const replacement = extension.processMethod(this, target, attributes);
          if (replacement instanceof Inline) {
            const inlineSubs = replacement.attributes.subs;
            if (inlineSubs) {
              const expandedSubs = this.expandSubs(inlineSubs, 'custom inline macro');
              if (expandedSubs) replacement.text = await this.applySubs(replacement.text, expandedSubs);
              delete replacement.attributes.subs;
            }
            return replacement.convert()
          } else if (replacement) {
            this.logger.info(`expected substitution value for custom inline macro to be of type Inline; got ${replacement.constructor.name}: ${match}`);
            return replacement
          }
          return ''
        });
      }
    }

    // kbd / btn macros (experimental)
    if (docAttrs.experimental !== undefined) {
      if (foundMacroishShort && (text.includes('kbd:') || text.includes('btn:'))) {
        text = await asyncReplace(text, globalRx(InlineKbdBtnMacroRx), async (match, p1, p2, p3) => {
          if (p1) return match.slice(1)
          if (p2 === 'kbd') {
            let keys = p3.trim();
            if (keys.includes(R_SB)) keys = keys.split(ESC_R_SB).join(R_SB);
            if (keys.length > 1) {
              let delimIdx = keys.indexOf(',', 1);
              const plusIdx = keys.indexOf('+', 1);
              if (delimIdx !== -1 && plusIdx !== -1) delimIdx = Math.min(delimIdx, plusIdx);
              else if (delimIdx === -1) delimIdx = plusIdx;

              if (delimIdx !== -1) {
                const delim = keys.charAt(delimIdx);
                if (keys.endsWith(delim)) {
                  keys = keys.slice(0, -1).split(delim).map((k) => k.trim());
                  keys[keys.length - 1] += delim;
                } else {
                  keys = keys.split(delim).map((k) => k.trim());
                }
              } else {
                keys = [keys];
              }
            } else {
              keys = [keys];
            }
            return new Inline(this, 'kbd', null, { attributes: { keys } }).convert()
          } else {
            // btn
            return new Inline(this, 'button', this.normalizeText(p3, true, true)).convert()
          }
        });
      }

      if (foundMacroish && text.includes('menu:')) {
        text = await asyncReplace(text, globalRx(InlineMenuMacroRx), async (match, p1, p2) => {
          if (match.startsWith(RS)) return match.slice(1)
          const menu = p1;
          let submenus, menuitem;
          if (p2) {
            let items = p2.includes(R_SB) ? p2.split(ESC_R_SB).join(R_SB) : p2;
            let delim = null;
            if (items.includes('&gt;')) delim = '&gt;';
            else if (items.includes(',')) delim = ',';
            if (delim) {
              const parts = items.split(delim).map((item) => item.trim());
              menuitem = parts.pop();
              submenus = parts;
            } else {
              submenus = [];
              menuitem = items.trimEnd();
            }
          } else {
            submenus = [];
            menuitem = null;
          }
          return new Inline(this, 'menu', null, { attributes: { menu, submenus, menuitem } }).convert()
        });
      }

      if (text.includes('"') && text.includes('&gt;')) {
        text = await asyncReplace(text, globalRx(InlineMenuRx), async (match, p1) => {
          if (match.startsWith(RS)) return match.slice(1)
          const parts = p1.split('&gt;').map((item) => item.trim());
          const menu = parts.shift();
          const menuitem = parts.pop() ?? null;
          const submenus = parts;
          return new Inline(this, 'menu', null, { attributes: { menu, submenus, menuitem } }).convert()
        });
      }
    }

    // image / icon macros
    if (foundMacroish && (text.includes('image:') || text.includes('icon:'))) {
      text = await asyncReplace(text, globalRx(InlineImageMacroRx), async (match, p1, p2) => {
        if (match.startsWith(RS)) return match.slice(1)
        let type, posattrs;
        if (match.startsWith('icon:')) {
          type = 'icon';
          posattrs = ['size'];
        } else {
          type = 'image';
          posattrs = ['alt', 'width', 'height'];
        }
        const target = p1;
        const attrs = await this.parseAttributes(p2, posattrs, { unescapeInput: true });
        let id;
        if (type !== 'icon') {
          id = attrs.id;
          doc.register('images', target);
          attrs.imagesdir = attrs.imagesdir ?? docAttrs.imagesdir;
        }
        attrs.alt = attrs.alt ?? (attrs['default-alt'] = basename(target, true).replace(/[_-]/g, ' '));
        return new Inline(this, 'image', null, { type, target, id, attributes: attrs }).convert()
      });
    }

    // index terms
    if ((text.includes('((') && text.includes('))')) || (foundMacroishShort && text.includes('dexterm'))) {
      text = await asyncReplace(text, globalRx(InlineIndextermMacroRx), async (match, p1, p2, p3) => {
        switch (p1) {
          case 'indexterm': {
            if (match.startsWith(RS)) return match.slice(1)
            let attrlist = this.normalizeText(p2, true, true);
            let attrs;
            if (attrlist.includes('=')) {
              const parsed = await new AttributeList(attrlist, this).parse();
              const primary = parsed[1];
              if (primary) {
                const terms = [primary];
                const secondary = parsed[2];
                if (secondary) {
                  terms.push(secondary);
                  const tertiary = parsed[3];
                  if (tertiary) terms.push(tertiary);
                }
                attrs = { ...parsed, terms };
                if (attrs['see-also']) {
                  const seeAlso = attrs['see-also'];
                  attrs['see-also'] = seeAlso.includes(',') ? seeAlso.split(',').map((s) => s.trimStart()) : [seeAlso];
                }
              } else {
                attrs = { terms: attrlist };
              }
            } else {
              attrs = { terms: this.splitSimpleCsv(attrlist) };
            }
            return new Inline(this, 'indexterm', null, { attributes: attrs }).convert()
          }
          case 'indexterm2': {
            if (match.startsWith(RS)) return match.slice(1)
            let term = this.normalizeText(p2, true, true);
            let attrs = null;
            if (term.includes('=')) {
              const parsed = await new AttributeList(term, this).parse();
              term = parsed[1] || term;
              if (parsed[1]) {
                attrs = parsed;
                if (attrs['see-also']) {
                  attrs['see-also'] = attrs['see-also'].includes(',')
                    ? attrs['see-also'].split(',').map((s) => s.trimStart())
                    : [attrs['see-also']];
                }
              } else {
                attrs = null;
              }
            }
            return new Inline(this, 'indexterm', term, { attributes: attrs, type: 'visible' }).convert()
          }
          default: {
            let enclText = p3;
            let visible = true, before = null, after = null;
            if (match.startsWith(RS)) {
              if (enclText.startsWith('(') && enclText.endsWith(')')) {
                enclText = enclText.slice(1, -1);
                visible = true;
                before = '(';
                after = ')';
              } else {
                return match.slice(1)
              }
            } else {
              if (enclText.startsWith('(')) {
                if (enclText.endsWith(')')) {
                  enclText = enclText.slice(1, -1);
                  visible = false;
                } else {
                  enclText = enclText.slice(1);
                  before = '(';
                  after = '';
                }
              } else if (enclText.endsWith(')')) {
                enclText = enclText.slice(0, -1);
                before = '';
                after = ')';
              }
            }
            let subbed_term;
            if (visible) {
              let term = this.normalizeText(enclText, true);
              let attrs = null;
              if (term.includes(';&')) {
                if (term.includes(' &gt;&gt; ')) {
                  const [t, , see] = partition(term, ' &gt;&gt; ');
                  term = t;
                  attrs = { see };
                } else if (term.includes(' &amp;&gt; ')) {
                  const parts = term.split(' &amp;&gt; ');
                  term = parts.shift();
                  attrs = { 'see-also': parts };
                }
              }
              subbed_term = await new Inline(this, 'indexterm', term, { attributes: attrs, type: 'visible' }).convert();
            } else {
              const attrs = {};
              let terms = this.normalizeText(enclText, true);
              if (terms.includes(';&')) {
                if (terms.includes(' &gt;&gt; ')) {
                  const [t, , see] = partition(terms, ' &gt;&gt; ');
                  terms = t;
                  attrs.see = see;
                } else if (terms.includes(' &amp;&gt; ')) {
                  const parts = terms.split(' &amp;&gt; ');
                  terms = parts.shift();
                  attrs['see-also'] = parts;
                }
              }
              attrs.terms = this.splitSimpleCsv(terms);
              subbed_term = await new Inline(this, 'indexterm', null, { attributes: attrs }).convert();
            }
            return before !== null ? `${before}${subbed_term}${after}` : subbed_term
          }
        }
      });
    }

    // inline URLs
    if (foundColon && text.includes('://')) {
      text = await asyncReplace(text, globalRx(InlineLinkRx), async (match, p1, p2, p3, p4, p5, p6, p7, p8) => {
        if (p2 && p5 == null) {
          if (p1.startsWith(RS)) return match.slice(1)
          if (p3.startsWith(RS)) return p1 + match.slice(p1.length + 1)
          if (!p6) return match
          const target = p3 + p6;
          doc.register('links', target);
          const linkText = docAttrs['hide-uri-scheme'] !== undefined ? target.replace(UriSniffRx, '') : target;
          return new Inline(this, 'anchor', linkText, { type: 'link', target, attributes: { role: 'bare' } }).convert()
        } else {
          if (p3.startsWith(RS)) return p1 + match.slice(p1.length + 1)
          let prefix = p1;
          let target = p3 + (p4 || p7 || '');
          let suffix = '';

          if (p5 != null) {
            if (prefix === 'link:') prefix = '';
            const rawLinkText = p5;
            var link_text = rawLinkText || null;
          } else {
            switch (prefix) {
              case 'link:':
              case '"':
              case "'":
                return match
            }
            switch (p8) {
              case ';':
                target = target.slice(0, -1);
                if (target.endsWith(')')) {
                  target = target.slice(0, -1);
                  suffix = ');';
                } else {
                  suffix = ';';
                }
                if (target === p3) return match
                break
              case ':':
                target = target.slice(0, -1);
                if (target.endsWith(')')) {
                  target = target.slice(0, -1);
                  suffix = '):';
                } else {
                  suffix = ':';
                }
                if (target === p3) return match
                break
            }
            var link_text = null;
          }

          const linkOpts = { type: 'link' };
          let attrs = null;
          let bare = false;

          if (link_text !== null) {
            let newLinkText = link_text.includes(R_SB) ? link_text.split(ESC_R_SB).join(R_SB) : link_text;
            link_text = newLinkText;

            if (!doc.compatMode && link_text.includes('=')) {
              const [extractedText, extractedAttrs] = await this.extractAttributesFromText(link_text, '');
              link_text = extractedText;
              newLinkText = extractedText;
              attrs = extractedAttrs;
              linkOpts.id = attrs?.id;
            }

            if (link_text.endsWith('^')) {
              newLinkText = link_text = link_text.slice(0, -1);
              if (attrs) {
                attrs.window = attrs.window ?? '_blank';
              } else {
                attrs = { window: '_blank' };
              }
            }

            if (newLinkText !== null && newLinkText !== undefined && newLinkText === '') {
              link_text = docAttrs['hide-uri-scheme'] !== undefined ? target.replace(UriSniffRx, '') : target;
              bare = true;
            }
          } else {
            link_text = docAttrs['hide-uri-scheme'] !== undefined ? target.replace(UriSniffRx, '') : target;
            bare = true;
          }

          if (bare) {
            if (attrs) {
              attrs.role = ('role' in (attrs || {})) ? `bare ${attrs.role}` : 'bare';
            } else {
              attrs = { role: 'bare' };
            }
          }

          linkOpts.target = target;
          doc.register('links', target);
          if (attrs) linkOpts.attributes = attrs;
          return `${prefix}${await new Inline(this, 'anchor', link_text, linkOpts).convert()}${suffix}`
        }
      });
    }

    // link: and mailto: macros
    if (foundMacroish && (text.includes('link:') || text.includes('ilto:'))) {
      text = await asyncReplace(text, globalRx(InlineLinkMacroRx), async (match, p1, p2, p3) => {
        if (match.startsWith(RS)) return match.slice(1)
        let target, mailtoText;
        if (p1) {
          mailtoText = p2;
          target = 'mailto:' + mailtoText;
        } else {
          target = p2;
        }

        let attrs = null;
        const linkOpts = { type: 'link' };
        let linkText = p3;

        if (linkText) {
          linkText = linkText.includes(R_SB) ? linkText.split(ESC_R_SB).join(R_SB) : linkText;
          if (p1) {
            if (!doc.compatMode && linkText.includes(',')) {
              const [extractedText, extractedAttrs] = await this.extractAttributesFromText(linkText, '');
              linkText = extractedText;
              attrs = extractedAttrs;
              linkOpts.id = attrs?.id;
              if (attrs?.[2]) {
                if (attrs[3]) {
                  target = `${target}?subject=${encodeUriComponent(attrs[2])}&amp;body=${encodeUriComponent(attrs[3])}`;
                } else {
                  target = `${target}?subject=${encodeUriComponent(attrs[2])}`;
                }
              }
            }
          } else if (!doc.compatMode && linkText.includes('=')) {
            const [extractedText, extractedAttrs] = await this.extractAttributesFromText(linkText, '');
            linkText = extractedText;
            attrs = extractedAttrs;
            linkOpts.id = attrs?.id;
          }

          if (linkText.endsWith('^')) {
            linkText = linkText.slice(0, -1);
            if (attrs) {
              attrs.window = attrs.window ?? '_blank';
            } else {
              attrs = { window: '_blank' };
            }
          }
        }

        if (!linkText) {
          if (p1) {
            linkText = mailtoText;
          } else {
            if (docAttrs['hide-uri-scheme'] !== undefined) {
              linkText = target.replace(UriSniffRx, '') || target;
            } else {
              linkText = target;
            }
            if (attrs) {
              attrs.role = ('role' in attrs) ? `bare ${attrs.role}` : 'bare';
            } else {
              attrs = { role: 'bare' };
            }
          }
        }

        linkOpts.target = target;
        doc.register('links', target);
        if (attrs) linkOpts.attributes = attrs;
        return new Inline(this, 'anchor', linkText, linkOpts).convert()
      });
    }

    // bare email addresses
    if (text.includes('@')) {
      text = await asyncReplace(text, globalRx(InlineEmailRx), async (match, p1) => {
        if (p1) return p1 === RS ? match.slice(1) : match
        const address = match;
        const target = 'mailto:' + address;
        doc.register('links', target);
        return new Inline(this, 'anchor', address, { type: 'link', target }).convert()
      });
    }

    // bibliography anchor
    if (foundSquareBracket && this.context === 'list_item' && this.parent.style === 'bibliography') {
      text = await asyncReplace(text, InlineBiblioAnchorRx, async (match, p1, p2) => {
        return new Inline(this, 'anchor', p2, { type: 'bibref', id: p1 }).convert()
      });
    }

    // inline anchors
    if ((foundSquareBracket && text.includes('[[')) || (foundMacroish && text.includes('or:'))) {
      text = await asyncReplace(text, globalRx(InlineAnchorRx), async (match, p1, p2, p3, p4, p5) => {
        if (p1) return match.slice(1)
        let id, reftext;
        if (p2) {
          id = p2;
          reftext = p3;
        } else {
          id = p4;
          reftext = p5 ? (p5.includes(R_SB) ? p5.split(ESC_R_SB).join(R_SB) : p5) : null;
        }
        return new Inline(this, 'anchor', reftext, { type: 'ref', id }).convert()
      });
    }

    // xref macros
    if ((text.includes('&') && text.includes(';&l')) || (foundMacroish && text.includes('xref:'))) {
      text = await asyncReplace(text, globalRx(InlineXrefMacroRx), async (match, p1, p2, p3) => {
        if (match.startsWith(RS)) return match.slice(1)
        const attrs = {};
        let refid, linkText, macro, path, fragment, target, src2src;

        if (p1) {
          refid = p1;
          if (refid.includes(',')) {
            const commaIdx = refid.indexOf(',');
            const rawLinkText = refid.slice(commaIdx + 1).trimStart();
            refid = refid.slice(0, commaIdx);
            linkText = rawLinkText || null;
          }
        } else {
          macro = true;
          refid = p2;
          if (p3) {
            linkText = p3.includes(R_SB) ? p3.split(ESC_R_SB).join(R_SB) : p3;
            if (!doc.compatMode && linkText.includes('=')) {
              const [extractedText, extractedAttrs] = await this.extractAttributesFromText(linkText);
              linkText = extractedText;
              Object.assign(attrs, extractedAttrs);
            }
          }
        }

        if (doc.compatMode) {
          fragment = refid;
        } else {
          const hashIdx = refid.indexOf('#');
          if (hashIdx !== -1 && (hashIdx === 0 || refid[hashIdx - 1] !== '&')) {
            if (hashIdx > 0) {
              const fragmentLen = refid.length - 1 - hashIdx;
              if (fragmentLen > 0) {
                path = refid.slice(0, hashIdx);
                fragment = refid.slice(hashIdx + 1);
              } else {
                path = refid.slice(0, -1);
              }
              if (macro) {
                if (path.endsWith('.adoc')) {
                  src2src = path = path.slice(0, -5);
                } else if (!isExtname(path)) {
                  src2src = path;
                }
              } else if (Object.keys(ASCIIDOC_EXTENSIONS).some((ext) => path.endsWith(ext))) {
                src2src = path = path.slice(0, path.lastIndexOf('.'));
              } else {
                src2src = path;
              }
            } else {
              target = refid;
              fragment = refid.slice(1);
            }
          } else if (macro) {
            if (refid.endsWith('.adoc')) {
              src2src = path = refid.slice(0, -5);
            } else if (isExtname(refid)) {
              path = refid;
            } else {
              fragment = refid;
            }
          } else {
            fragment = refid;
          }
        }

        if (target) {
          // handles: #id
          refid = fragment;
          if (this.logger.isInfo?.() && !doc.catalog.refs[refid]) {
            this.logger.info(`possible invalid reference: ${refid}`);
          }
        } else if (path) {
          if (src2src && (doc.attributes.docname === path || doc.catalog.includes[path])) {
            if (fragment) {
              refid = fragment;
              path = null;
              target = `#${fragment}`;
              if (this.logger.isInfo?.() && !doc.catalog.refs[refid]) {
                this.logger.info(`possible invalid reference: ${refid}`);
              }
            } else {
              refid = null;
              path = null;
              target = '#';
            }
          } else {
            const relfileprefix = doc.attributes.relfileprefix || '';
            const relfilesuffix = src2src
              ? (doc.attributes.relfilesuffix ?? doc.outfilesuffix)
              : '';
            const resolvedPath = `${relfileprefix}${path}${relfilesuffix}`;
            refid = path;
            path = resolvedPath;
            if (fragment) {
              refid = `${refid}#${fragment}`;
              target = `${path}#${fragment}`;
            } else {
              target = path;
            }
          }
        } else if (doc.compatMode || false) {
          refid = fragment;
          target = `#${fragment}`;
          if (this.logger.isInfo?.() && !doc.catalog.refs[refid]) {
            this.logger.info(`possible invalid reference: ${refid}`);
          }
        } else if (doc.catalog.refs[fragment]) {
          refid = fragment;
          target = `#${fragment}`;
        } else if ((fragment.includes(' ') || fragment.toLowerCase() !== fragment) && (refid = await doc.resolveId(fragment))) {
          fragment = refid;
          target = `#${refid}`;
        } else {
          refid = fragment;
          target = `#${fragment}`;
          if (this.logger.isInfo?.()) this.logger.info(`possible invalid reference: ${refid}`);
        }

        if (path != null) attrs.path = path;
        if (fragment != null) attrs.fragment = fragment;
        attrs.refid = refid;
        return new Inline(this, 'anchor', linkText, { type: 'xref', target, attributes: attrs }).convert()
      });
    }

    // footnote macros
    if (foundMacroish && text.includes('tnote')) {
      text = await asyncReplace(text, globalRx(InlineFootnoteMacroRx), async (match, p1, p2, p3) => {
        if (match.startsWith(RS)) return match.slice(1)

        let id, content, type, target;
        if (p1) {
          // footnoteref
          if (p3) {
            const commaIdx = p3.indexOf(',');
            if (commaIdx >= 0) {
              id = p3.slice(0, commaIdx);
              content = p3.slice(commaIdx + 1);
            } else {
              // reference only (no text), e.g. footnoteref:[id]
              id = p3;
            }
            if (!doc.compatMode) {
              this.logger.warn(`found deprecated footnoteref macro: ${match}; use footnote macro with target instead`);
            }
          } else {
            return match
          }
        } else {
          id = p2;
          content = p3;
        }

        let index;
        if (id) {
          const footnote = doc.footnotes.find((f) => f.id === id);
          if (footnote) {
            index = footnote.index;
            content = footnote.text;
            type = 'xref';
            target = id;
            id = null;
          } else if (content) {
            content = await this.restorePassthroughs(this.normalizeText(content, true, true));
            index = doc.counter('footnote-number');
            doc.register('footnotes', new Document.Footnote(index, id, content));
            type = 'ref';
            target = null;
          } else {
            this.logger.warn(`invalid footnote reference: ${id}`);
            type = 'xref';
            target = id;
            content = id;
            id = null;
          }
        } else if (content) {
          content = await this.restorePassthroughs(this.normalizeText(content, true, true));
          index = doc.counter('footnote-number');
          doc.register('footnotes', new Document.Footnote(index, id, content));
          type = null;
          target = null;
        } else {
          return match
        }

        return new Inline(this, 'footnote', content, {
          attributes: { index },
          id,
          target,
          type,
        }).convert()
      });
    }

    return text
  },

  /**
   * Substitute post replacements (hard line breaks).
   *
   * @param {string} text
   * @returns {string}
   */
  async subPostReplacements(text) {
    if ('hardbreaks-option' in this.attributes || 'hardbreaks-option' in this.document.attributes) {
      const lines = text.split(LF$1);
      if (lines.length < 2) return text
      const last = lines.pop();
      const converted = await Promise.all(lines.map((line) =>
        new Inline(
          this,
          'break',
          line.endsWith(HARD_LINE_BREAK) ? line.slice(0, -2) : line,
          { type: 'line' }
        ).convert()
      ));
      return [...converted, last].join(LF$1)
    } else if (text.includes(PLUS) && text.includes(HARD_LINE_BREAK)) {
      return asyncReplace(text, globalRx(HardLineBreakRx), async (match, p1) => {
        return new Inline(this, 'break', p1, { type: 'line' }).convert()
      })
    }
    return text
  },

  /**
   * Apply verbatim substitutions on source.
   *
   * @param {string} source
   * @param {boolean} processCallouts
   * @returns {string}
   */
  async subSource(source, processCallouts) {
    return processCallouts
      ? await this.subCallouts(this.subSpecialchars(source))
      : this.subSpecialchars(source)
  },

  /**
   * Substitute callout source references.
   *
   * @param {string} text
   * @returns {string}
   */
  async subCallouts(text) {
    const calloutRx = this.hasAttr('line-comment')
      ? CalloutSourceRxMap[this.attr('line-comment')]
      : CalloutSourceRx;
    let autonum = 0;
    return asyncReplace(text, globalRx(calloutRx), async (match, p1, p2, p3, p4) => {
      if (p2) {
        return match.replace(RS, '')
      }
      const guard = p1 || (p3 === '--' ? ['<!--', '-->'] : null);
      const numeral = p4 === '.' ? String(++autonum) : p4;
      return new Inline(this, 'callout', numeral, {
        id: this.document.callouts.readNextId(),
        attributes: { guard },
      }).convert()
    })
  },

  /**
   * Highlight (colorize) the source code using a syntax highlighter.
   *
   * @param {string} source
   * @param {boolean} processCallouts
   * @returns {string}
   */
  async highlightSource(source, processCallouts) {
    const syntaxHl = this.document.syntaxHighlighter;
    if (!syntaxHl || !syntaxHl.handlesHighlighting()) {
      return this.subSource(source, processCallouts)
    }

    let calloutMarks;
    if (processCallouts) {
[source, calloutMarks] = this.extractCallouts(source);
    }

    const docAttrs = this.document.attributes;
    const syntaxHlName = syntaxHl.name;
    let linenumsMode = null;
    let startLineNumber = null;
    if (this.hasOption('linenums')) {
      linenumsMode = (docAttrs[`${syntaxHlName}-linenums-mode`] || 'table');
      startLineNumber = parseInt(this.getAttribute('start', 1), 10);
      if (startLineNumber < 1) startLineNumber = 1;
    }

    let highlightLines = null;
    if (this.hasAttr('highlight')) {
      highlightLines = this.resolveLinesToHighlight(source, this.getAttribute('highlight'), startLineNumber);
    }

    const [highlighted, sourceOffset] = syntaxHl.highlight(this, source, this.getAttribute('language'), {
      callouts: calloutMarks,
      cssMode: (docAttrs[`${syntaxHlName}-css`] || 'class'),
      highlightLines,
      numberLines: linenumsMode,
      startLineNumber,
      style: docAttrs[`${syntaxHlName}-style`],
    });

    let result = highlighted;
    if (this.passthroughs.length > 0) {
      result = result.replace(globalRx(HIGHLIGHTED_PASS_SLOT_RX), `${PASS_START}$1${PASS_END}`);
    }

    if (!calloutMarks || Object.keys(calloutMarks).length === 0) {
      return result
    }
    return await this.restoreCallouts(result, calloutMarks, sourceOffset)
  },

  /**
   * Resolve line numbers to highlight from a spec string.
   *
   * @param {string} source
   * @param {string} spec   - e.g. "1-5, !2, 10" or "1..5;!2;10"
   * @param {number|null} [start=null]
   * @returns {number[]}
   */
  resolveLinesToHighlight(source, spec, start = null) {
    let lines = [];
    if (spec.includes(' ')) spec = spec.split(' ').join('');
    const entries = spec.includes(',') ? spec.split(',') : spec.split(';');

    for (let entry of entries) {
      let negate = false;
      if (entry.startsWith('!')) {
        entry = entry.slice(1);
        negate = true;
      }
      const delim = entry.includes('..') ? '..' : (entry.includes('-') ? '-' : null);
      if (delim) {
        const [fromStr, , toStr] = partition(entry, delim);
        const from = parseInt(fromStr, 10);
        let to = (!toStr || (to = parseInt(toStr, 10)) < 0) ? (source.split(LF$1).length + 1) : to;
        if (typeof to === 'string') to = parseInt(to, 10);
        const range = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        if (negate) {
          lines = arrayDiff(lines, range);
        } else {
          lines = arrayUnion(lines, range);
        }
      } else if (negate) {
        const val = parseInt(entry, 10);
        lines = lines.filter((l) => l !== val);
      } else {
        const line = parseInt(entry, 10);
        if (!lines.includes(line)) lines.push(line);
      }
    }

    if (start) {
      const shift = start - 1;
      if (shift !== 0) lines = lines.map((l) => l - shift);
    }

    return lines.sort((a, b) => a - b)
  },

  /**
   * Extract passthrough text for reinsertion after processing.
   *
   * @param {string} text
   * @returns {string} Text with passthrough regions replaced by placeholders.
   */
  extractPassthroughs(text) {
    const compatMode = this.document.compatMode;
    const passthrus = this.passthroughs;

    if (text.includes('++') || text.includes('$$') || text.includes('ss:')) {
      text = text.replace(globalRx(InlinePassMacroRx), (match, p1, p2, p3, p4, p5, p6, p7, p8) => {
        const boundary = p4; // $$, ++, or +++
        if (boundary) {
          // skip ++ in compat mode
          if (compatMode && boundary === '++') {
            const prefix = p2 ? `${p1}[${p2}]${p3}` : `${p1}${p3}`;
            return `${prefix}++${this.extractPassthroughs(p5)}++`
          }

          let attributes, oldBehavior, preceding;
          if (p2) {
            const attrlist = p2;
            const escapeCount = p3.length;
            if (escapeCount > 0) {
              return `${p1}[${attrlist}]${RS.repeat(escapeCount - 1)}${boundary}${p5}${boundary}`
            } else if (p1 === RS) {
              preceding = `[${attrlist}]`;
            } else if (boundary === '++') {
              if (attrlist === 'x-') {
                oldBehavior = true;
                attributes = {};
              } else if (attrlist.endsWith(' x-')) {
                oldBehavior = true;
                attributes = this.parseQuotedTextAttributes(attrlist.slice(0, -3));
              } else {
                attributes = this.parseQuotedTextAttributes(attrlist);
              }
            } else {
              attributes = this.parseQuotedTextAttributes(attrlist);
            }
          } else {
            const escapeCount = p3.length;
            if (escapeCount > 0) {
              return `${RS.repeat(escapeCount - 1)}${boundary}${p5}${boundary}`
            }
          }

          const subs = boundary === '+++' ? [] : [...BASIC_SUBS];
          let passthruKey;
          if (attributes) {
            if (oldBehavior) {
              passthrus[passthruKey = passthrus.length] = { text: p5, subs: NORMAL_SUBS, type: 'monospaced', attributes };
            } else {
              passthrus[passthruKey = passthrus.length] = { text: p5, subs, type: 'unquoted', attributes };
            }
          } else {
            passthrus[passthruKey = passthrus.length] = { text: p5, subs };
          }
          return `${preceding || ''}${PASS_START}${passthruKey}${PASS_END}`
        } else {
          // pass:[]
          if (p6 === RS) return match.slice(1)
          let passthruKey;
          if (p7) {
            passthrus[passthruKey = passthrus.length] = {
              text: this.normalizeText(p8, null, true),
              subs: this.resolvePassSubs(p7),
            };
          } else {
            passthrus[passthruKey = passthrus.length] = { text: this.normalizeText(p8, null, true) };
          }
          return `${PASS_START}${passthruKey}${PASS_END}`
        }
      });
    }

    const [passInlineChar1, passInlineChar2, passInlineRx] = InlinePassRx[compatMode];

    if (text.includes(passInlineChar1) || (passInlineChar2 && text.includes(passInlineChar2))) {
      text = text.replace(globalRx(passInlineRx), (match, p1, p2, p3, p4, p5, p6, p7, p8) => {
        const preceding = p1;
        const attrlist = p4 || p3;
        const escaped = !!p5;
        const quotedText = p6;
        const formatMark = p7;
        const content = p8;

        let oldBehavior, oldBehaviorForced, attributes;

        if (compatMode) {
          oldBehavior = true;
        } else if (attrlist && (attrlist === 'x-' || attrlist.endsWith(' x-'))) {
          oldBehavior = true;
          oldBehaviorForced = true;
        }

        if (attrlist) {
          if (escaped) {
            return `${preceding}[${attrlist}]${quotedText.slice(1)}`
          } else if (preceding === RS) {
            if (oldBehaviorForced && formatMark === '`') {
              return `${preceding}[${attrlist}]${quotedText}`
            }
            if (compatMode && formatMark === '`') {
              // escaped role in compat-mode: role becomes literal text, backtick span still processed as monospaced
              let passthruKey;
              passthrus[passthruKey = passthrus.length] = { text: content, subs: BASIC_SUBS, type: 'monospaced' };
              return `[${attrlist}]${PASS_START}${passthruKey}${PASS_END}`
            }
            return `[${attrlist}]${quotedText}`  // preceding replaced by attrlist form
          } else if (oldBehaviorForced) {
            attributes = attrlist === 'x-' ? {} : this.parseQuotedTextAttributes(attrlist.slice(0, -3));
          } else {
            attributes = this.parseQuotedTextAttributes(attrlist);
          }
        } else if (escaped) {
          return `${preceding}${quotedText.slice(1)}`
        } else if (compatMode && preceding === RS) {
          return quotedText
        }

        let passthruKey;
        if (compatMode) {
          passthrus[passthruKey = passthrus.length] = { text: content, subs: BASIC_SUBS, attributes, type: 'monospaced' };
        } else if (attributes) {
          if (oldBehavior) {
            const subs = formatMark === '`' ? BASIC_SUBS : NORMAL_SUBS;
            passthrus[passthruKey = passthrus.length] = { text: content, subs, attributes, type: 'monospaced' };
          } else {
            passthrus[passthruKey = passthrus.length] = { text: content, subs: BASIC_SUBS, attributes, type: 'unquoted' };
          }
        } else {
          passthrus[passthruKey = passthrus.length] = { text: content, subs: BASIC_SUBS };
        }

        return `${preceding || ''}${PASS_START}${passthruKey}${PASS_END}`
      });
    }

    // stem macros (in a subsequent step to allow escaping by the former)
    if (text.includes(':') && (text.includes('stem:') || text.includes('math:'))) {
      text = text.replace(globalRx(InlineStemMacroRx), (match, p1, p2, p3) => {
        if (match.startsWith(RS)) return match.slice(1)
        let type = p1;
        if (type === 'stem') {
          type = STEM_TYPE_ALIASES[this.document.attributes.stem];
        }
        let content = this.normalizeText(p3, null, true);
        if (type === 'latexmath' && content.startsWith('$') && content.endsWith('$')) {
          content = content.slice(1, -1);
        }
        const subs = p2
          ? this.resolvePassSubs(p2, 'stem macro')
          : (this.document.basebackend('html') ? BASIC_SUBS : null);
        const passthruKey = passthrus.length;
        passthrus[passthruKey] = { text: content, subs, type };
        return `${PASS_START}${passthruKey}${PASS_END}`
      });
    }

    return text
  },

  /**
   * Restore passthrough text by reinserting into placeholder positions.
   *
   * @param {string} text
   * @returns {string}
   */
  async restorePassthroughs(text) {
    if (!text.includes(PASS_START)) return text
    const passthrus = this.passthroughs;
    return asyncReplace(text, globalRx(PASS_SLOT_RX), async (match, p1) => {
      const pass = passthrus[parseInt(p1, 10)];
      if (pass) {
        let subbedText = await this.applySubs(pass.text, pass.subs);
        const type = pass.type;
        if (type) {
          const attributes = pass.attributes;
          const id = attributes?.id;
          subbedText = await new Inline(this, 'quoted', subbedText, { type, id, attributes }).convert();
        }
        return subbedText.includes(PASS_START) ? this.restorePassthroughs(subbedText) : subbedText
      } else {
        this.logger.error(`unresolved passthrough detected: ${text}`);
        return '??pass??'
      }
    })
  },

  /**
   * Resolve the list of comma-delimited subs against the possible options.
   *
   * @param {string} subs
   * @param {'block'|'inline'} [type='block']
   * @param {string[]|null} [defaults=null]
   * @param {string|null} [subject=null]
   * @returns {string[]|undefined}
   */
  resolveSubs(subs, type = 'block', defaults = null, subject = null) {
    if (!subs || subs.length === 0) return undefined
    let candidates = null;
    if (subs.includes(' ')) subs = subs.split(' ').join('');
    const modifiersPresent = SubModifierSniffRx.test(subs);

    for (let key of subs.split(',')) {
      let modifierOperation = null;
      if (modifiersPresent) {
        const first = key.charAt(0);
        if (first === '+') {
          modifierOperation = 'append';
          key = key.slice(1);
        } else if (first === '-') {
          modifierOperation = 'remove';
          key = key.slice(1);
        } else if (key.endsWith('+')) {
          modifierOperation = 'prepend';
          key = key.slice(0, -1);
        }
      }

      let resolvedKeys;
      if (type === 'inline' && (key === 'verbatim' || key === 'v')) {
        resolvedKeys = BASIC_SUBS;
      } else if (key in SUB_GROUPS) {
        resolvedKeys = SUB_GROUPS[key];
      } else if (type === 'inline' && key.length === 1 && key in SUB_HINTS) {
        const resolvedKey = SUB_HINTS[key];
        resolvedKeys = SUB_GROUPS[resolvedKey] || [resolvedKey];
      } else {
        resolvedKeys = [key];
      }

      if (modifierOperation) {
        candidates = candidates ?? (defaults ? [...defaults] : []);
        switch (modifierOperation) {
          case 'append':
            candidates = [...candidates, ...resolvedKeys];
            break
          case 'prepend':
            candidates = [...resolvedKeys, ...candidates];
            break
          case 'remove':
            candidates = arrayDiff(candidates, resolvedKeys);
            break
        }
      } else {
        candidates = candidates ?? [];
        candidates = [...candidates, ...resolvedKeys];
      }
    }

    if (!candidates) return undefined

    // weed out invalid options and remove duplicates (order preserved; first occurrence wins)
    const resolved = arrayIntersect(candidates, SUB_OPTIONS[type]);
    const invalid = arrayDiff(candidates, resolved);
    if (invalid.length > 0) {
      this.logger.warn(
        `invalid substitution type${invalid.length > 1 ? 's' : ''}${subject ? ' for ' : ''}${subject || ''}: ${invalid.join(', ')}`
      );
    }
    return resolved
  },

  /** Call resolveSubs for the 'block' type. */
  resolveBlockSubs(subs, defaults, subject) {
    return this.resolveSubs(subs, 'block', defaults, subject)
  },

  /** Call resolveSubs for the 'inline' type with subject set as passthrough macro. */
  resolvePassSubs(subs, subject = 'passthrough macro') {
    return this.resolveSubs(subs, 'inline', null, subject)
  },

  /**
   * Expand all groups in the subs list and return.
   *
   * @param {string|string[]} subs
   * @param {string|null} [subject=null]
   * @returns {string[]|null}
   */
  expandSubs(subs, subject = null) {
    if (typeof subs === 'string') {
      // subs is a single key name
      if (subs === 'none') return null
      return SUB_GROUPS[subs] || [subs]
    } else if (Array.isArray(subs)) {
      const expandedSubs = [];
      for (const key of subs) {
        if (key !== 'none') {
          const subGroup = SUB_GROUPS[key];
          if (subGroup) {
            expandedSubs.push(...subGroup);
          } else {
            expandedSubs.push(key);
          }
        }
      }
      return expandedSubs.length === 0 ? null : expandedSubs
    } else {
      return this.resolveSubs(subs, 'inline', null, subject)
    }
  },

  /**
   * Commit the requested substitutions to this block.
   * Looks for an attribute named "subs". If present, resolves substitutions.
   */
  commitSubs() {
    let defaultSubs = this.defaultSubs;
    if (!defaultSubs) {
      switch (this.contentModel) {
        case 'simple':
          defaultSubs = NORMAL_SUBS;
          break
        case 'verbatim':
          defaultSubs = this.context === 'verse' ? NORMAL_SUBS : VERBATIM_SUBS;
          break
        case 'raw':
          defaultSubs = this.context === 'stem' ? BASIC_SUBS : NO_SUBS;
          break
        default:
          return this.subs
      }
    }

    const customSubs = this.attributes.subs;
    if (customSubs) {
      this.subs = this.resolveBlockSubs(customSubs, defaultSubs, this.context) || [];
    } else {
      this.subs = [...defaultSubs];
    }

    if (
      this.context === 'listing' &&
      this.style === 'source' &&
      this.document.syntaxHighlighter?.handlesHighlighting()
    ) {
      const idx = this.subs.indexOf('specialcharacters');
      if (idx !== -1) this.subs[idx] = 'highlight';
    }

    return null
  },

  /**
   * Parse attributes in name or name=value format from a comma-separated String.
   *
   * @param {string} attrlist
   * @param {string[]} [posattrs=[]]
   * @param {Object} [opts={}]
   * @returns {Object}
   */
  async parseAttributes(attrlist, posattrs = [], opts = {}) {
    if (!attrlist || attrlist.length === 0) return {}
    if (opts.unescapeInput) attrlist = this.normalizeText(attrlist, true, true);
    if ((opts.subInput || opts.sub_input) && attrlist.includes(ATTR_REF_HEAD)) {
      attrlist = this.document.subAttributes(attrlist);
    }
    const block = (opts.subResult || opts.sub_result) ? this : null;
    const al = new AttributeList(attrlist, block);
    if (opts.into) {
      return al.parseInto(opts.into, posattrs)
    }
    return al.parse(posattrs)
  },

  // ── Private methods ────────────────────────────────────────────────────────

  async extractAttributesFromText(text, defaultText = null) {
    const attrlist = text.includes(LF$1) ? text.split(LF$1).join(' ') : text;
    const attrs = await new AttributeList(attrlist, this).parse();
    const resolvedText = attrs[1];
    if (resolvedText != null) {
      if (resolvedText === attrlist) {
        Object.keys(attrs).forEach((k) => delete attrs[k]);
        return [text, attrs]
      }
      return [resolvedText, attrs]
    }
    return [defaultText, attrs]
  },

  extractCallouts(source) {
    const calloutMarks = {};
    let autonum = 0;
    let lineno = 0;
    let lastLineno = null;
    const calloutRx = this.hasAttr('line-comment')
      ? CalloutExtractRxMap[this.attr('line-comment')]
      : CalloutExtractRx;

    const lines = source.split(LF$1).map((line) => {
      lineno++;
      return line.replace(globalRx(calloutRx), (match, p1, p2, p3, p4) => {
        if (p2) {
          return match.replace(RS, '')
        }
        const guard = p1 || (p3 === '--' ? ['<!--', '-->'] : null);
        const numeral = p4 === '.' ? String(++autonum) : p4
        ;(calloutMarks[lineno] = calloutMarks[lineno] || []).push([guard, numeral]);
        lastLineno = lineno;
        return ''
      })
    });

    let result = lines.join(LF$1);
    if (lastLineno !== null) {
      if (lastLineno === lineno) result = `${result}${LF$1}`;
    } else {
      return [result, null]
    }
    return [result, calloutMarks]
  },

  async restoreCallouts(source, calloutMarks, sourceOffset = null) {
    let preamble = '';
    if (sourceOffset !== null) {
      preamble = source.slice(0, sourceOffset);
      source = source.slice(sourceOffset);
    }
    let lineno = 0;
    const result = await Promise.all(source.split(LF$1).map(async (line) => {
      const conums = calloutMarks[++lineno];
      if (conums) {
        delete calloutMarks[lineno];
        if (conums.length === 1) {
          const [guard, numeral] = conums[0];
          return `${line}${await new Inline(this, 'callout', numeral, {
            id: this.document.callouts.readNextId(),
            attributes: { guard },
          }).convert()}`
        } else {
          const converted = await Promise.all(conums.map(([guard, numeral]) =>
            new Inline(this, 'callout', numeral, {
              id: this.document.callouts.readNextId(),
              attributes: { guard },
            }).convert()
          ));
          return `${line}${converted.join(' ')}`
        }
      }
      return line
    }));
    return preamble + result.join(LF$1)
  },

  async convertQuotedText(args, type, scope) {
    // args: [fullMatch, group1, group2, ...]
    const fullMatch = args[0];
    if (fullMatch.startsWith(RS)) {
      if (scope === 'constrained') {
        const attrs = args[2];
        if (attrs) {
          return `[${attrs}]${await new Inline(this, 'quoted', args[3], { type }).convert()}`
        }
      }
      return fullMatch.slice(1)
    }

    if (scope === 'constrained') {
      const attrlist = args[2];
      let id, attributes;
      if (attrlist) {
        attributes = this.parseQuotedTextAttributes(attrlist);
        id = attributes.id;
        if (type === 'mark') type = 'unquoted';
      }
      return `${args[1] || ''}${await new Inline(this, 'quoted', args[3], { type, id, attributes }).convert()}`
    } else {
      const attrlist = args[1];
      let id, attributes;
      if (attrlist) {
        attributes = this.parseQuotedTextAttributes(attrlist);
        id = attributes.id;
        if (type === 'mark') type = 'unquoted';
      }
      return new Inline(this, 'quoted', args[2], { type, id, attributes }).convert()
    }
  },

  doReplacement(match, replacement, restore) {
    const captured = match[0];
    if (captured.includes(RS)) {
      return captured.replace(RS, '')
    }
    switch (restore) {
      case 'none':
        return replacement
      case 'bounding':
        return match[1] + replacement + match[2]
      default: // 'leading'
        return match[1] + replacement
    }
  },

  /** Inserts text into a formatted text enclosure (sprintf). */
  subPlaceholder(format, ...args) {
    let i = 0;
    return format.replace(/%s/g, () => String(args[i++] ?? ''))
  },

  parseQuotedTextAttributes(str) {
    if (str.includes(ATTR_REF_HEAD)) str = this.subAttributes(str);
    // for compliance, only consider first positional attribute
    if (str.includes(',')) str = str.slice(0, str.indexOf(','));
    str = str.trim();
    if (!str) return {}
    if ((str.startsWith('.') || str.startsWith('#')) && Compliance.shorthandPropertySyntax) {
      const [before, , after] = partition(str, '#');
      const attrs = {};
      if (!after) {
        if (before.length > 1) attrs.role = before.slice(1).split('.').join(' ').trimStart();
      } else {
        const [id, , roles] = partition(after, '.');
        if (id) attrs.id = id;
        if (!roles) {
          if (before.length > 1) attrs.role = before.slice(1).split('.').join(' ').trimStart();
        } else if (before.length > 1) {
          attrs.role = (before + '.' + roles).slice(1).split('.').join(' ').trimStart();
        } else {
          attrs.role = roles.split('.').join(' ');
        }
      }
      return attrs
    }
    return { role: str }
  },

  normalizeText(text, normalizeWhitespace = null, unescapeClosingSquareBrackets = null) {
    if (text && text.length > 0) {
      if (normalizeWhitespace) text = text.trim().split(LF$1).join(' ');
      if (unescapeClosingSquareBrackets && text.includes(R_SB)) {
        text = text.split(ESC_R_SB).join(R_SB);
      }
    }
    return text
  },

  splitSimpleCsv(str) {
    if (!str || str.length === 0) return []
    if (str.includes('"')) {
      const values = [];
      let accum = '';
      let quoteOpen = false;
      for (const c of str) {
        if (c === ',') {
          if (quoteOpen) {
            accum += c;
          } else {
            values.push(accum.trim());
            accum = '';
          }
        } else if (c === '"') {
          quoteOpen = !quoteOpen;
        } else {
          accum += c;
        }
      }
      values.push(accum.trim());
      return values
    }
    return str.split(',').map((item) => item.trim())
  },
};
Object.assign(AbstractNode.prototype, Substitutors);

// ESM conversion of table.rb
//
// Ruby-to-JavaScript notes:
//   - Table::Rows#[] (alias for send) → explicit bySection/head/foot/body access.
//   - Table::Cell references Document, PreprocessorReader, Parser — these are
//     imported lazily (dynamic import) to avoid circular dependency issues.
//   - String#squeeze(ch) → replaceAll(ch+ch, ch) loop (only used for '"').
//   - Number#truncate(precision) → Math.trunc(n * 10^p) / 10^p.
//   - :asciidoc / :literal / :header symbols → strings 'asciidoc', 'literal', 'header'.


// Helper: truncate a float to `precision` decimal places (like Ruby's Float#truncate).
function truncate (value, precision) {
  const factor = Math.pow(10, precision);
  return Math.trunc(value * factor) / factor
}

// Helper: collapse consecutive identical characters (like Ruby's String#squeeze(q)).
function squeezeChar (str, ch) {
  const double = ch + ch;
  while (str.includes(double)) str = str.replaceAll(double, ch);
  return str
}

const DEFAULT_PRECISION = 4;

// ── Table ─────────────────────────────────────────────────────────────────────

class Table extends AbstractBlock {
  constructor (parent, attributes) {
    super(parent, 'table');
    this.rows    = new Table.Rows();
    this.columns = [];
    this.hasHeaderOption = false;

    // Resolve tablepcwidth from 'width' attribute
    let pcwidthIntval = 100;
    const pcwidth = attributes['width'];
    if (pcwidth != null) {
      let v = parseInt(pcwidth, 10);
      if (isNaN(v)) v = 0;
      if (v > 100 || v < 1) {
        if (!(v === 0 && (pcwidth === '0' || pcwidth === '0%'))) v = 100;
      }
      pcwidthIntval = v;
    }
    this.attributes['tablepcwidth'] = pcwidthIntval;

    const pagewidthAttr = this.document.attributes['pagewidth'];
    if (pagewidthAttr != null) {
      const abswidthVal = truncate((pcwidthIntval / 100.0) * parseFloat(pagewidthAttr), DEFAULT_PRECISION);
      this.attributes['tableabswidth'] = abswidthVal === Math.trunc(abswidthVal) ? Math.trunc(abswidthVal) : abswidthVal;
    }

    if ('rotate-option' in attributes) this.attributes['orientation'] = 'landscape';
  }

  // Internal: Returns the header option state if the row being processed is the header row, otherwise false.
  headerRow () {
    const val = this.hasHeaderOption;
    return (val && this.rows.body.length === 0) ? val : false
  }

  // Internal: Create Column objects from the column spec array.
  createColumns (colspecs) {
    const cols = [];
    let autowidthCols = null;
    let widthBase = 0;
    for (const colspec of colspecs) {
      const colwidth = colspec['width'];
      cols.push(new Table.Column(this, cols.length, colspec));
      if (colwidth < 0) {
        (autowidthCols ??= []).push(cols[cols.length - 1]);
      } else {
        widthBase += colwidth;
      }
    }
    this.columns = cols;
    const numCols = cols.length;
    if (numCols > 0) {
      this.attributes['colcount'] = numCols;
      const effectiveWidthBase = (widthBase > 0 || autowidthCols) ? widthBase : null;
      this.assignColumnWidths(effectiveWidthBase, autowidthCols);
    }
  }

  // Internal: Assign percentage (and absolute) widths to all columns.
  assignColumnWidths (widthBase = null, autowidthCols = null) {
    const precision = DEFAULT_PRECISION;
    let totalWidth  = 0;
    let colPcwidth  = 0;

    if (widthBase != null) {
      if (autowidthCols) {
        let autowidth;
        if (widthBase > 100) {
          autowidth = 0;
          this.logger.warn(`total column width must not exceed 100% when using autowidth columns; got ${widthBase}%`);
        } else {
          autowidth = truncate((100.0 - widthBase) / autowidthCols.length, precision);
          if (Math.trunc(autowidth) === autowidth) autowidth = Math.trunc(autowidth);
          widthBase = 100;
        }
        const autowAttrs = { width: autowidth, 'autowidth-option': '' };
        for (const col of autowidthCols) col.updateAttributes(autowAttrs);
      }
      for (const col of this.columns) {
        totalWidth += (colPcwidth = col.assignWidth(null, widthBase, precision));
      }
    } else {
      colPcwidth = truncate(100.0 / this.columns.length, precision);
      if (Math.trunc(colPcwidth) === colPcwidth) colPcwidth = Math.trunc(colPcwidth);
      for (const col of this.columns) {
        totalWidth += col.assignWidth(colPcwidth, null, precision);
      }
    }

    // Donate balance to the last column (half-up rounding)
    if (totalWidth !== 100) {
      const balance = +((100 - totalWidth + colPcwidth).toFixed(precision));
      this.columns[this.columns.length - 1].assignWidth(balance, null, precision);
    }
  }

  // Internal: Partition rows into header, footer, and body.
  async partitionHeaderFooter (attrs) {
    const body         = this.rows.body;
    let numBodyRows    = this.attributes['rowcount'] = body.length;

    if (numBodyRows > 0) {
      if (this.hasHeaderOption === true) {
        this.rows.head = [await Promise.all(body.shift().map(cell => cell.reinitialize(true)))];
        numBodyRows--;
      } else if (this.hasHeaderOption === null) {
        this.hasHeaderOption = false;
        body.unshift(await Promise.all(body.shift().map(cell => cell.reinitialize(false))));
      }
    }

    if (numBodyRows > 0 && ('footer-option' in attrs)) {
      this.rows.foot = [body.pop()];
    }
  }
}

// ── Table.Rows ────────────────────────────────────────────────────────────────

Table.Rows = class Rows {
  constructor (head = [], foot = [], body = []) {
    this.head = head;
    this.foot = foot;
    this.body = body;
  }

  // Public: Retrieve the rows grouped by section as a nested Array.
  bySection () {
    return [['head', this.head], ['body', this.body], ['foot', this.foot]]
  }

  toObject () {
    return { head: this.head, body: this.body, foot: this.foot }
  }
};

// ── Table.Column ──────────────────────────────────────────────────────────────

Table.Column = class Column extends AbstractNode {
  constructor (table, index, attributes = {}) {
    super(table, 'table_column');
    this.style = attributes['style'] ?? null;
    attributes['colnumber'] = index + 1;
    if (!('width' in attributes)) attributes['width'] = 1;
    if (!('halign' in attributes)) attributes['halign'] = 'left';
    if (!('valign' in attributes)) attributes['valign'] = 'top';
    this.updateAttributes(attributes);
  }

  // Alias for parent (always a Table).
  get table () { return this.parent }

  // Internal: Calculate and assign the widths for this column.
  //
  // Returns the resolved colpcwidth value.
  assignWidth (colPcwidth, widthBase, precision) {
    if (widthBase != null) {
      colPcwidth = truncate(parseFloat(this.attributes['width']) * 100.0 / widthBase, precision);
      if (Math.trunc(colPcwidth) === colPcwidth) colPcwidth = Math.trunc(colPcwidth);
    }
    const tableAbswidth = this.parent.attributes['tableabswidth'];
    if (tableAbswidth != null) {
      const colAbswidth = truncate((colPcwidth / 100.0) * tableAbswidth, precision);
      this.attributes['colabswidth'] = colAbswidth === Math.trunc(colAbswidth) ? Math.trunc(colAbswidth) : colAbswidth;
    }
    this.attributes['colpcwidth'] = colPcwidth;
    return colPcwidth
  }

  isBlock ()  { return false }
  isInline () { return false }
};

// ── Table.Cell ────────────────────────────────────────────────────────────────

class Cell extends AbstractBlock {
  static get DOUBLE_LF () { return LF$1 + LF$1 }

  constructor (column, cellText, attributes = {}, opts = {}) {
    super(column, 'table_cell');
    this._cursor         = null;
    this._reinitializeArgs = null;
    if (this.document.sourcemap && opts.cursor) {
      this.sourceLocation = Object.assign({}, opts.cursor);
    }

    let cellStyle = null;
    let inHeaderRow = false;
    let asciidoc = false;
    let literal  = false;
    let normalPsv = false;
    let innerDocumentCursor = null;

    if (column) {
      inHeaderRow = column.table.headerRow();
      if (inHeaderRow) {
        if (inHeaderRow === 'implicit') {
          const cs = column.style ?? (attributes && attributes['style']);
          if (cs === 'asciidoc' || cs === 'literal') {
            this._reinitializeArgs = [column, cellText, attributes && { ...attributes }, opts];
          }
          cellStyle = null;
        }
        // else: don't set cellStyle from column for header row
      } else {
        cellStyle = column.style ?? null;
      }
      // Inherit column attributes
      this.updateAttributes(column.attributes);
    }

    if (attributes != null) {
      if (Object.keys(attributes).length === 0) {
        this.colspan = null;
        this.rowspan = null;
      } else {
        this.colspan = attributes['colspan'] ? parseInt(attributes['colspan'], 10) : null;
        this.rowspan = attributes['rowspan'] ? parseInt(attributes['rowspan'], 10) : null;
        delete attributes['colspan'];
        delete attributes['rowspan'];
        if (!inHeaderRow) cellStyle = attributes['style'] ?? cellStyle;
        this.updateAttributes(attributes);
      }

      switch (cellStyle) {
        case 'asciidoc': {
          asciidoc = true;
          innerDocumentCursor = opts.cursor;
          cellText = cellText.trimEnd();
          if (cellText.startsWith(LF$1)) {
            let linesAdvanced = 0;
            while (cellText.startsWith(LF$1)) {
              cellText = cellText.slice(1);
              linesAdvanced++;
            }
            if (innerDocumentCursor && typeof innerDocumentCursor.advance === 'function') {
              innerDocumentCursor.advance(linesAdvanced);
            }
          } else {
            cellText = cellText.trimStart();
          }
          break
        }
        case 'literal':
          literal = true;
          cellText = cellText.trimEnd();
          while (cellText.startsWith(LF$1)) cellText = cellText.slice(1);
          break
        default:
          normalPsv = true;
          cellText = cellText != null ? cellText.trim() : '';
      }
    } else {
      this.colspan = null;
      this.rowspan = null;
      if (cellStyle === 'asciidoc') asciidoc = true;
    }

    if (asciidoc) {
      const parentDoc = this.document;
      // Store the setup data for create() to handle asynchronously.
      this._innerDocSetup = {
        lines: cellText.split(LF$1, -1),
        parentDoc,
        parentDoctitle: parentDoc.attributes['doctitle'],
        options: {
          safe: parentDoc.safe,
          backend: parentDoc.backend,
          header_footer: false,
          parent: parentDoc,
          cursor: innerDocumentCursor,
        },
      };
      delete parentDoc.attributes['doctitle'];
      this._subs = null;
    } else if (literal) {
      this.contentModel = 'verbatim';
      this._subs = [...BASIC_SUBS];
    } else {
      if (normalPsv) {
        if (inHeaderRow) {
          this._cursor = opts.cursor ?? null;
        } else {
          this._catalogInlineAnchor(cellText, opts.cursor);
        }
      }
      this.contentModel = 'simple';
      this._subs = [...NORMAL_SUBS];
    }
    this._text   = cellText;
    this.style   = cellStyle;
  }

  // Alias for parent (always a Column).
  get column () { return this.parent }

  // Public: Factory — create and fully initialize a Cell asynchronously.
  // For AsciiDoc cells, parses the nested document.
  // NOTE: _innerContent is NOT pre-computed here. Document.convert() will call
  // _convertAsciiDocCells() after parse completes (so callouts are rewound and
  // all cross-references from the parent document are already registered).
  static async create (column, cellText, attributes = {}, opts = {}) {
    const cell = new Table.Cell(column, cellText, attributes, opts);
    if (cell._innerDocSetup) {
      const { lines, parentDoc, parentDoctitle, options } = cell._innerDocSetup;
      cell._innerDocSetup = null;
      const innerDoc = await parentDoc.constructor.create(lines, options);
      if (parentDoctitle) parentDoc.attributes['doctitle'] = parentDoctitle;
      cell._innerDocument = innerDoc;
    }
    return cell
  }

  async reinitialize (hasHeader) {
    if (hasHeader) {
      this._reinitializeArgs = null;
    } else if (this._reinitializeArgs) {
      return Table.Cell.create(...this._reinitializeArgs)
    } else {
      this.style = this.attributes['style'] ?? null;
    }
    if (this._cursor) this._catalogInlineAnchor();
    return this
  }

  _catalogInlineAnchor (cellText = this._text, cursor = null) {
    if (!cursor) {
      cursor = this._cursor;
      this._cursor = null;
    }
    if (!cellText.startsWith('[[')) return
    const m = cellText.match(LeadingInlineAnchorRx);
    if (!m) return
    const doc = this.document;
    let reftext = m[2] ?? null;
    if (reftext && reftext.includes(ATTR_REF_HEAD)) reftext = doc.subAttributes(reftext);
    doc.register('refs', [m[1], new Inline(this, 'anchor', reftext, { type: 'ref', id: m[1] })]);
  }

  // Public: Get the String text with substitutions applied.
  // The result is pre-computed during Document.parse() via precomputeText().
  // Falls back to the raw text if precomputeText() has not been called yet.
  get text () {
    return this._convertedText ?? this._text ?? null
  }

  // Public: Pre-compute the converted text asynchronously.
  // Called during Document.parse() so the synchronous getter works during conversion.
  async precomputeText () {
    if (this._subs && this._convertedText == null) {
      this._convertedText = await this.applySubs(this._text, this._subs);
      // Capture the cellbgcolor attribute value as set by {set:cellbgcolor:...} in cell text.
      // Since {set:...} attribute assignments happen during applySubs, and the document attribute
      // is shared state, we must capture it per-cell immediately after text processing.
      this._cellbgcolor = this.document.attributes['cellbgcolor'];
    }
  }

  set text (val) { this._text = val; this._convertedText = null; }

  // Public: Get the content — converted body data.
  // For AsciiDoc cells, returns the pre-computed content (set by Document.convert()).
  async content () {
    if (this.style === 'asciidoc') {
      return this._innerContent ?? ''
    }
    if (this._text.includes(Table.Cell.DOUBLE_LF)) {
      const parts = [];
      for (const rawPara of this.text.split(BlankLineRx)) {
        const para = rawPara.trim();
        if (!para) continue
        const cs = this.style;
        parts.push((cs && cs !== 'header')
          ? await (new Inline(this.parent, 'quoted', para, { type: cs })).convert()
          : para);
      }
      return parts
    }
    const subbedText = this.text;
    if (!subbedText) return []
    const cs = this.style;
    if (cs && cs !== 'header') {
      return [await (new Inline(this.parent, 'quoted', subbedText, { type: cs })).convert()]
    }
    return [subbedText]
  }

  lines () { return this._text.split(LF$1) }
  source () { return this._text }

  get innerDocument () { return this._innerDocument ?? null }

  get file ()   { return this.sourceLocation?.file ?? null }
  get lineno () { return this.sourceLocation?.lineno ?? null }

  toString () {
    return `${super.toString()} - [text: ${this._text}, colspan: ${this.colspan ?? 1}, rowspan: ${this.rowspan ?? 1}, attributes: ${JSON.stringify(this.attributes)}]`
  }
}
Table.Cell = Cell;

// ── Table.ParserContext ───────────────────────────────────────────────────────

Table.ParserContext = class ParserContext {
  static get FORMATS () {
    return new Set(['psv', 'csv', 'dsv', 'tsv'])
  }

  static get DELIMITERS () {
    return {
      psv:  ['|',  /\|/],
      csv:  [',',  /,/],
      dsv:  [':',  /:/],
      tsv:  ['\t', /\t/],
      '!sv': ['!', /!/],
    }
  }

  constructor (reader, table, attributes = {}) {
    this._reader = reader;
    this._startCursor = reader.cursor;
    reader.mark();
    this.table    = table;
    this.buffer   = '';

    // Determine format
    let xsv;
    if ('format' in attributes) {
      xsv = attributes['format'];
      if (ParserContext.FORMATS.has(xsv)) {
        if (xsv === 'tsv') {
          this.format = 'csv';
        } else {
          this.format = xsv;
          if (xsv === 'psv' && table.document.nested()) xsv = '!sv';
        }
      } else {
        this.logger.error(this.messageWithContext(`illegal table format: ${xsv}`, { source_location: reader.cursorAtPrevLine() }));
        this.format = 'psv';
        xsv = table.document.nested() ? '!sv' : 'psv';
      }
    } else {
      this.format = 'psv';
      xsv = table.document.nested() ? '!sv' : 'psv';
    }

    // Determine delimiter
    const delimiters = ParserContext.DELIMITERS;
    if ('separator' in attributes) {
      const sep = attributes['separator'];
      if (!sep) {
[this.delimiter, this.delimiterRe] = delimiters[xsv];
      } else if (sep === '\\t') {
[this.delimiter, this.delimiterRe] = delimiters['tsv'];
      } else {
        this.delimiter   = sep;
        this.delimiterRe = new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
    } else {
[this.delimiter, this.delimiterRe] = delimiters[xsv];
    }

    this.colcount       = table.columns.length === 0 ? -1 : table.columns.length;
    this._cellspecs     = [];
    this._cellOpen      = false;
    this._activeRowspans = [0];
    this._columnVisits  = 0;
    this._currentRow    = [];
    this._linenum       = -1;
  }

  startsWith (line) {
    return line.startsWith(this.delimiter)
  }

  matchDelimiter (line) {
    return line.match(this.delimiterRe)
  }

  skipPastDelimiter (pre) {
    this.buffer = `${this.buffer}${pre}${this.delimiter}`;
  }

  skipPastEscapedDelimiter (pre) {
    this.buffer = `${this.buffer}${pre.slice(0, -1)}${this.delimiter}`;
  }

  bufferHasUnclosedQuotesInText (text, q = '"') {
    let record = text.trim();
    if (record === q) return true
    if (!record.startsWith(q)) return false
    const qq = q + q;
    const trailingQuote = record.endsWith(q);
    if ((trailingQuote && record.endsWith(qq)) || record.startsWith(qq)) {
      record = squeezeChar(record, q);
      return record.startsWith(q) && !record.endsWith(q)
    }
    return !trailingQuote
  }

  bufferHasUnclosedQuotes (append = null, q = '"') {
    const record = (append ? this.buffer + append : this.buffer).trim();
    if (!record.startsWith(q)) return false
    // Walk the quoted field character by character (RFC 4180)
    let i = 1; // skip the opening quote
    while (i < record.length) {
      if (record[i] === q) {
        if (i + 1 < record.length && record[i + 1] === q) {
          i += 2; // escaped quote ""
        } else {
          return false // closing quote found → field is closed
        }
      } else {
        i++;
      }
    }
    return true // closing quote never found
  }

  takeCellspec () {
    return this._cellspecs.shift() ?? null
  }

  pushCellspec (cellspec = {}) {
    this._cellspecs.push(cellspec ?? {});
  }

  keepCellOpen ()  { this._cellOpen = true; }
  markCellClosed () { this._cellOpen = false; }
  isCellOpen ()    { return this._cellOpen }
  isCellClosed ()  { return !this._cellOpen }

  async closeOpenCell (nextCellspec = {}) {
    this.pushCellspec(nextCellspec);
    if (this.isCellOpen()) await this.closeCell(true);
    this._advance();
  }

  async closeCell (eol = false) {
    let cellText, cellspec, repeat;

    if (this.format === 'psv') {
      cellText      = this.buffer;
      this.buffer   = '';
      cellspec      = this.takeCellspec();
      if (cellspec) {
        repeat = cellspec['repeatcol'] ?? 1;
        delete cellspec['repeatcol'];
      } else {
        this.logger.error(this.messageWithContext('table missing leading separator; recovering automatically', {
          source_location: this._startCursor,
        }));
        cellspec = {};
        repeat   = 1;
      }
    } else {
      cellText    = this.buffer.trim();
      this.buffer = '';
      cellspec    = null;
      repeat      = 1;
      if (this.format === 'csv' && cellText && cellText.includes('"')) {
        const q = '"';
        if (cellText.startsWith(q)) {
          if (cellText.length > 1 && cellText.endsWith(q) && !this.bufferHasUnclosedQuotesInText(cellText, q)) {
            const inner = cellText.slice(1, cellText.length - 1);
            cellText = squeezeChar(inner.trim(), q);
          } else {
            this.logger.error(this.messageWithContext('unclosed quote in CSV data; setting cell to empty', {
              source_location: this._reader.cursorAtPrevLine(),
            }));
            cellText = '';
          }
        } else {
          cellText = squeezeChar(cellText, '"');
        }
      }
    }

    for (let i = 1; i <= repeat; i++) {
      let column;
      if (this.colcount === -1) {
        this.table.columns.push((column = new Table.Column(this.table, this.table.columns.length + i - 1)));
        if (cellspec && 'colspan' in cellspec) {
          const extraCols = parseInt(cellspec['colspan'], 10) - 1;
          if (extraCols > 0) {
            const offset = this.table.columns.length;
            for (let j = 0; j < extraCols; j++) {
              this.table.columns.push(new Table.Column(this.table, offset + j));
            }
          }
        }
      } else {
        column = this.table.columns[this._currentRow.length] ?? null;
      }

      const cursorBeforeMark = this._reader.cursorBeforeMark();
      this._reader.mark();
      const cell = await Table.Cell.create(column, cellText, cellspec, { cursor: cursorBeforeMark });

      if (cell.rowspan && cell.rowspan !== 1) {
        this._activateRowspan(cell.rowspan, cell.colspan ?? 1);
      }
      this._columnVisits += (cell.colspan ?? 1);
      this._currentRow.push(cell);

      const rowStatus = this._endOfRow();
      if (rowStatus > -1 && (this.colcount !== -1 || this._linenum > 0 || (eol && i === repeat))) {
        rowStatus > 0 ? (
          this.logger.error(this.messageWithContext('dropping cell because it exceeds specified number of columns', { source_location: cursorBeforeMark })),
          this._closeRow(true)
        ) : this._closeRow();
      }
    }
    this._cellOpen = false;
  }

  closeTable () {
    if (this._columnVisits === 0) return
    this.logger.error(this.messageWithContext('dropping cells from incomplete row detected end of table', {
      source_location: this._reader.cursorBeforeMark(),
    }));
  }

  // Private

  _closeRow (drop = false) {
    if (!drop) this.table.rows.body.push(this._currentRow);
    if (this.colcount === -1) this.colcount = this._columnVisits;
    this._columnVisits = 0;
    this._currentRow   = [];
    this._activeRowspans.shift();
    this._activeRowspans[0] ??= 0;
  }

  _activateRowspan (rowspan, colspan) {
    for (let i = 1; i < rowspan; i++) {
      this._activeRowspans[i] = (this._activeRowspans[i] ?? 0) + colspan;
    }
  }

  _endOfRow () {
    if (this.colcount === -1) return 0
    const eff = this._columnVisits + (this._activeRowspans[0] ?? 0);
    if (eff < this.colcount) return -1
    if (eff === this.colcount) return 0
    return 1
  }

  _advance () {
    this._linenum++;
  }
};

applyLogging(Table.ParserContext.prototype);

// ESM conversion of parser.rb
//
// Ruby-to-JavaScript notes:
//   - All methods are static on the Parser class (Ruby class methods).
//   - Ruby Struct BlockMatchData → plain object { context, masq, tip, terminator }.
//   - Ruby's regex captures ($1, $2, …) → JS match array m[1], m[2], …
//   - Ruby .nil_or_empty? → !val (or val == null || val === '')
//   - Ruby .to_i → parseInt(val, 10) (returns 0 for nil/non-numeric)
//   - ListContinuationMarker module → Symbol used for identity checks.
//   - Logging mixin applied via applyLogging().


// ── List continuation identity marker ────────────────────────────────────────
// Used to distinguish list continuation placeholders from regular strings.
const LIST_CONTINUATION_SYM = Symbol('ListContinuation');

function isListContinuation (v) {
  return v != null && v[LIST_CONTINUATION_SYM] === true
}

function makeListContinuationPlaceholder () {
  const s = new String(''); // eslint-disable-line no-new-wrappers
  s[LIST_CONTINUATION_SYM] = true;
  return s
}

function makeListContinuationString () {
  const s = new String(LIST_CONTINUATION); // eslint-disable-line no-new-wrappers
  s[LIST_CONTINUATION_SYM] = true;
  return s
}

const ListContinuationPlaceholder = makeListContinuationPlaceholder();
const ListContinuationString      = makeListContinuationString();

// Author attribute keys
const AuthorKeys = new Set(['author', 'authorinitials', 'firstname', 'middlename', 'lastname', 'email']);

// Cell alignment and style maps
const TableCellHorzAlignments = { '<': 'left', '>': 'right', '^': 'center' };
const TableCellVertAlignments = { '<': 'top',  '>': 'bottom', '^': 'middle' };
const TableCellStyles = {
  d: 'none', s: 'strong', e: 'emphasis', m: 'monospaced',
  h: 'header', l: 'literal', a: 'asciidoc',
};

// ── Parser ────────────────────────────────────────────────────────────────────

class Parser {
  // Prevent instantiation
  constructor () {
    throw new Error('Parser cannot be instantiated')
  }

  // Public: Parse AsciiDoc source from reader into document.
  static async parse (reader, document, options = {}) {
    const headerOnly = options.header_only ?? false;
    let blockAttributes = await Parser.parseDocumentHeader(reader, document, headerOnly);

    if (!headerOnly) {
      while (await reader.hasMoreLines()) {
        const [newSection, attrs] = await Parser.nextSection(reader, document, blockAttributes);
        blockAttributes = attrs;
        if (newSection) {
          document.assignNumeral(newSection);
          document.blocks.push(newSection);
        }
      }
    }
    return document
  }

  // Public: Parse the document header.
  static async parseDocumentHeader (reader, document, headerOnly = false) {
    let blockAttrs = await reader.skipBlankLines() != null ? await Parser.parseBlockMetadataLines(reader, document) : {};
    const docAttrs = document.attributes;

    const implicitDoctitle = await Parser.isNextLineDoctitle(reader, blockAttrs, docAttrs['leveloffset']);
    if (implicitDoctitle && (blockAttrs['title'] || blockAttrs['style'])) {
      docAttrs['authorcount'] = 0;
      return document.finalizeHeader(blockAttrs, false)
    }

    let doctitleAttrVal = null;
    const existingDoctitle = docAttrs['doctitle'];
    if (existingDoctitle && existingDoctitle !== '') {
      document.title = doctitleAttrVal = existingDoctitle;
    }

    if (implicitDoctitle) {
      const sourceLocation = document.sourcemap ? reader.cursor : null;
      const [sectId,, l0SectionTitle,, atx] = await Parser.parseSectionTitle(reader, document);
      let finalSectTitle = l0SectionTitle;

      if (doctitleAttrVal) {
        finalSectTitle = null;
      } else {
        document.title = finalSectTitle;
        let sanitized = document.subSpecialchars(finalSectTitle);
        if (sanitized.includes(ATTR_REF_HEAD)) {
          sanitized = document.subAttributes(sanitized, { attribute_missing: 'skip' });
        }
        docAttrs['doctitle'] = doctitleAttrVal = sanitized;
      }

      if (sourceLocation && document.header) {
        document.header.sourceLocation = sourceLocation;
      }

      if (!atx && !document.isAttributeLocked('compat-mode')) {
        docAttrs['compat-mode'] = '';
      }
      if (blockAttrs['separator'] && !document.isAttributeLocked('title-separator')) {
        docAttrs['title-separator'] = blockAttrs['separator'];
      }
      const docId = blockAttrs['id'];
      if (docId) {
        document.id = docId;
      }
      if (blockAttrs['role']) docAttrs['role'] = blockAttrs['role'];
      if (blockAttrs['reftext']) docAttrs['reftext'] = blockAttrs['reftext'];
      blockAttrs = {};

      const modifiedAttrs = document._attributesModified;
      modifiedAttrs.delete('doctitle');
      await Parser.parseHeaderMetadata(reader, document, null);

      if (modifiedAttrs.has('doctitle')) {
        const val = docAttrs['doctitle'];
        if (!val || val === '' || val === doctitleAttrVal) {
          docAttrs['doctitle'] = doctitleAttrVal;
        } else {
          document.title = val;
        }
      } else if (!finalSectTitle) {
        modifiedAttrs.add('doctitle');
      }

      if (docId) document.register('refs', [docId, document]);
    } else if (docAttrs['author']) {
      const authorMeta = Parser.processAuthors(docAttrs['author'], true, false);
      if (docAttrs['authorinitials']) delete authorMeta['authorinitials'];
      Object.assign(docAttrs, authorMeta);
    } else if (docAttrs['authors']) {
      const authorMeta = Parser.processAuthors(docAttrs['authors'], true);
      Object.assign(docAttrs, authorMeta);
    } else {
      docAttrs['authorcount'] = 0;
    }

    if (document.doctype === 'manpage') {
      await Parser.parseManpageHeader(reader, document, blockAttrs, headerOnly);
    }

    return document.finalizeHeader(blockAttrs)
  }

  // Public: Parse manpage header.
  static async parseManpageHeader (reader, document, blockAttributes, headerOnly = false) {
    const docAttrs = document.attributes;
    const doctitle  = docAttrs['doctitle'] || '';
    const m = doctitle.match(ManpageTitleVolnumRx);
    let manvolnum;
    if (m) {
      manvolnum = docAttrs['manvolnum'] = m[2];
      let mantitle = m[1];
      if (mantitle.includes(ATTR_REF_HEAD)) mantitle = document.subAttributes(mantitle);
      docAttrs['mantitle'] = mantitle.toLowerCase();
    } else {
      Parser.logger.error(Parser.messageWithContext('non-conforming manpage title', { source_location: reader.cursorAtLine(1) }));
      docAttrs['mantitle'] = doctitle || docAttrs['docname'] || 'command';
      manvolnum = docAttrs['manvolnum'] = '1';
    }

    let manname = docAttrs['manname'];
    if (manname && docAttrs['manpurpose']) {
      docAttrs['manname-title'] ??= 'Name';
      docAttrs['mannames'] = [manname];
      if (document.backend === 'manpage') {
        docAttrs['docname'] = manname;
        docAttrs['outfilesuffix'] = `.${manvolnum}`;
      }
    } else if (headerOnly) ; else {
      await reader.skipBlankLines();
      reader.save();
      Object.assign(blockAttributes, await Parser.parseBlockMetadataLines(reader, document));
      const nameSectionLevel = await Parser.isNextLineSection(reader, {});
      if (nameSectionLevel !== null && nameSectionLevel !== undefined) {
        if (nameSectionLevel === 1) {
          const nameSection = await Parser.initializeSection(reader, document, {});
          const buffer = (await reader.readLinesUntil({ break_on_blank_lines: true, skip_line_comments: true }))
            .map(l => l.trimStart()).join(' ');
          const nm = buffer.match(ManpageNamePurposeRx);
          let errorMsg = null;
          if (nm) {
            let mname = nm[1];
            if (mname.includes(ATTR_REF_HEAD)) mname = document.subAttributes(mname);
            let mannames;
            if (mname.includes(',')) {
              mannames = mname.split(',').map(n => n.trimStart());
              mname = mannames[0];
            } else {
              mannames = [mname];
            }
            let manpurpose = nm[2];
            if (manpurpose.includes(ATTR_REF_HEAD)) manpurpose = document.subAttributes(manpurpose);
            docAttrs['manname-title'] ??= nameSection.title;
            if (nameSection.id) docAttrs['manname-id'] = nameSection.id;
            docAttrs['manname']    = mname;
            docAttrs['mannames']   = mannames;
            docAttrs['manpurpose'] = manpurpose;
            if (document.backend === 'manpage') {
              docAttrs['docname']       = mname;
              docAttrs['outfilesuffix'] = `.${manvolnum}`;
            }
          } else {
            errorMsg = 'non-conforming name section body';
          }
          if (errorMsg) {
            reader.restoreSave();
            Parser.logger.error(Parser.messageWithContext(errorMsg, { source_location: reader.cursor }));
            const mn = docAttrs['docname'] || 'command';
            docAttrs['manname']  = mn;
            docAttrs['mannames'] = [mn];
            if (document.backend === 'manpage') {
              docAttrs['docname']       = mn;
              docAttrs['outfilesuffix'] = `.${manvolnum}`;
            }
          } else {
            reader.discardSave();
          }
        } else {
          reader.restoreSave();
          Parser.logger.error(Parser.messageWithContext('name section must be at level 1', { source_location: reader.cursor }));
        }
      } else {
        reader.restoreSave();
        Parser.logger.error(Parser.messageWithContext('name section expected', { source_location: reader.cursor }));
        const mn = docAttrs['docname'] || 'command';
        docAttrs['manname']  = mn;
        docAttrs['mannames'] = [mn];
        if (document.backend === 'manpage') {
          docAttrs['docname']       = mn;
          docAttrs['outfilesuffix'] = `.${manvolnum}`;
        }
      }
    }
  }

  // Public: Return the next section from the reader.
  //
  // Returns [section_or_null, orphaned_attributes].
  static async nextSection (reader, parent, attributes = {}) {
    let preamble = null, intro = null, part = false;

    const parentIsDocument = parent.context === 'document';
    let section, currentLevel, expectedNextLevel, expectedNextLevelAlt;
    let book, document;

    if (parentIsDocument && parent.blocks.length === 0 &&
        (parent.hasHeader() || ('invalid-header' in attributes && !!attributes['invalid-header'] && delete attributes['invalid-header'] !== undefined) ||
         typeof await Parser.isNextLineSection(reader, attributes) !== 'number')) {
      // We are at the start of document processing
      document = parent;
      book = document.doctype === 'book';
      if (parent.hasHeader() || (book && attributes[1] !== 'abstract')) {
        preamble = intro = new Block(parent, 'preamble', { content_model: 'compound' });
        if (book && parent.hasAttr('preface-title')) {
          preamble.title = parent.attr('preface-title');
        }
        parent.blocks.push(preamble);
      }
      section = parent;
      currentLevel = 0;
      if ('fragment' in parent.attributes) {
        expectedNextLevel = -1;
      } else if (book) {
        expectedNextLevel = 1;
        expectedNextLevelAlt = 0;
      } else {
        expectedNextLevel = 1;
      }
    } else {
      document = parent.document;
      book = document.doctype === 'book';
      section = await Parser.initializeSection(reader, parent, attributes);
      const title = attributes['title'];
      attributes = title ? { title } : {};
      currentLevel = section.level;
      expectedNextLevel = currentLevel + 1;
      if (currentLevel === 0) {
        part = book;
      } else if (currentLevel === 1 && section.special) {
        const sn = section.sectname;
        if (sn !== 'appendix' && sn !== 'preface' && sn !== 'abstract') {
          expectedNextLevel = null;
        }
      }
    }

    await reader.skipBlankLines();

    while (await reader.hasMoreLines()) {
      await Parser.parseBlockMetadataLines(reader, document, attributes);
      let nextLevel = await Parser.isNextLineSection(reader, attributes);

      if (nextLevel !== null && nextLevel !== undefined && nextLevel !== false) {
        const leveloffset = document.attr('leveloffset');
        if (leveloffset) {
          nextLevel += parseInt(leveloffset, 10);
          if (nextLevel < 0) nextLevel = 0;
        }

        if (nextLevel > currentLevel) {
          if (expectedNextLevel != null) {
            if (nextLevel !== expectedNextLevel &&
                !(expectedNextLevelAlt != null && nextLevel === expectedNextLevelAlt) &&
                expectedNextLevel >= 0) {
              const expectedCondition = expectedNextLevelAlt != null
                ? `expected levels ${expectedNextLevelAlt} or ${expectedNextLevel}`
                : `expected level ${expectedNextLevel}`;
              Parser.logger.warn(Parser.messageWithContext(`section title out of sequence: ${expectedCondition}, got level ${nextLevel}`, { source_location: reader.cursor }));
            }
          } else {
            Parser.logger.error(Parser.messageWithContext(`${section.sectname} sections do not support nested sections`, { source_location: reader.cursor }));
          }
          const [newSection, attrs] = await Parser.nextSection(reader, section, attributes);
          attributes = attrs;
          section.assignNumeral(newSection);
          section.blocks.push(newSection);
        } else if (nextLevel === 0 && section === document) {
          if (!book) {
            Parser.logger.error(Parser.messageWithContext('level 0 sections can only be used when doctype is book', { source_location: reader.cursor }));
          }
          const [newSection, attrs] = await Parser.nextSection(reader, section, attributes);
          attributes = attrs;
          section.assignNumeral(newSection);
          section.blocks.push(newSection);
        } else {
          break
        }
      } else {
        const blockCursor = reader.cursor;
        const newBlock = await Parser.nextBlock(reader, intro ?? section, attributes, { parse_metadata: false });
        if (newBlock) {
          if (part) {
            if (!section.hasBlocks()) {
              if (newBlock.style !== 'partintro') {
                if (newBlock.style === 'open' && newBlock.context === 'open') {
                  newBlock.style = 'partintro';
                } else {
                  newBlock.parent = (intro = new Block(section, 'open', { content_model: 'compound' }));
                  intro.style = 'partintro';
                  section.blocks.push(intro);
                }
              } else if (newBlock.contentModel === 'simple') {
                newBlock.contentModel = 'compound';
                newBlock.append(new Block(newBlock, 'paragraph', { source: newBlock.lines, subs: newBlock.subs }));
                newBlock.lines.length = 0;
                newBlock.subs.length = 0;
              }
            } else if (section.blocks.length === 1) {
              const firstBlock = section.blocks[0];
              if (!intro && firstBlock.contentModel === 'compound') {
                Parser.logger.error(Parser.messageWithContext('illegal block content outside of partintro block', { source_location: blockCursor }));
              } else if (firstBlock.contentModel !== 'compound') {
                newBlock.parent = (intro = new Block(section, 'open', { content_model: 'compound' }));
                if (firstBlock.style === (intro.style = 'partintro')) {
                  firstBlock.context = 'paragraph';
                  firstBlock.style = null;
                }
                section.blocks.shift();
                intro.append(firstBlock);
                section.blocks.push(intro);
              }
            }
          }
(intro ?? section).blocks.push(newBlock);
          for (const key of Object.keys(attributes)) delete attributes[key];
        }
      }

      if (await reader.skipBlankLines() == null) break
    }

    if (part) {
      if (!section.hasBlocks() || section.blocks[section.blocks.length - 1].context !== 'section') {
        Parser.logger.error(Parser.messageWithContext('invalid part, must have at least one section (e.g., chapter, appendix, etc.)', { source_location: reader.cursor }));
      }
    } else if (preamble) {
      if (preamble.hasBlocks()) {
        if (book || document.blocks[1] || false) {
          if (document.sourcemap) preamble.sourceLocation = preamble.blocks[0].sourceLocation;
        } else {
          document.blocks.shift();
          while (preamble.blocks.length > 0) {
            document.append(preamble.blocks.shift());
          }
        }
      } else {
        document.blocks.shift();
      }
    }

    return [section === parent ? null : section, { ...attributes }]
  }

  // Public: Parse and return the next Block at the Reader's current location.
  static async nextBlock (reader, parent, attributes = {}, options = {}) {
    const skipped = await reader.skipBlankLines();
    if (skipped == null) return null

    let textOnly = options.text_only ?? null;
    if (textOnly && skipped > 0) {
      delete options.text_only;
      textOnly = null;
    }

    const document  = parent.document;
    const parseMetadata = options.parse_metadata !== false;

    if (parseMetadata) {
      while (await Parser.parseBlockMetadataLine(reader, document, attributes, options)) {
        await reader.readLine();
        if (await reader.skipBlankLines() == null) return null
      }
    }

    const extensions = document.extensions;
    const blockExtensions     = extensions?.hasBlocks?.();
    const blockMacroExtensions = extensions?.hasBlockMacros?.();

    reader.mark();
    let thisLine = await reader.readLine();
    if (thisLine === undefined) return null
    const docAttrs = document.attributes;
    const style    = attributes[1] ?? null;
    let block = null, blockContext = null, cloakedContext = null, terminator = null;

    const delimitedBlock = Parser.isDelimitedBlock(thisLine, true);
    if (delimitedBlock) {
      blockContext  = cloakedContext = delimitedBlock.context;
      terminator    = delimitedBlock.terminator;
      if (style) {
        if (style !== blockContext) {
          if (delimitedBlock.masq.has(style)) {
            blockContext = style;
          } else if (delimitedBlock.masq.has('admonition') && ADMONITION_STYLES.has(style)) {
            blockContext = 'admonition';
          } else if (blockExtensions && extensions.registeredForBlock(style, blockContext)) {
            blockContext = style;
          } else {
            // unknown style; revert to block context
            if (Parser.logger.isDebug()) Parser.logger.debug(Parser.messageWithContext(`unknown style for ${blockContext} block: ${style}`, { source_location: reader.cursor }));
          }
        }
      } else {
        attributes['style'] = blockContext;
      }
    }

    if (!delimitedBlock) {
      // Processed once (break used for flow control)
      do {
        // Verbatim style shortcut
        if (style && Compliance.strictVerbatimParagraphs && VERBATIM_STYLES.has(style)) {
          blockContext   = style;
          cloakedContext = 'paragraph';
          reader.unshiftLine(thisLine);
          break
        }

        let indented, ch0;

        if (thisLine.startsWith(' ')) {
          indented = true;
          ch0 = ' ';
          {
            const stripped = thisLine.trimStart();
            const firstChar = stripped[0];
            if (MARKDOWN_THEMATIC_BREAK_CHARS[firstChar] && MarkdownThematicBreakRx.test(thisLine)) {
              block = new Block(parent, 'thematic_break', { content_model: 'empty' });
              break
            }
          }
        } else if (thisLine.startsWith('\t')) {
          indented = true;
          ch0 = '\t';
        } else {
          indented = false;
          ch0 = thisLine[0];
          const layoutBreakChars = HYBRID_LAYOUT_BREAK_CHARS ;

          if (!textOnly && layoutBreakChars[ch0]) {
            thisLine.length;
            if (ExtLayoutBreakRx.test(thisLine) ) {
              block = new Block(parent, layoutBreakChars[ch0], { content_model: 'empty' });
              break
            }
          }

          if (thisLine.endsWith(']') && thisLine.includes('::')) {
            // Block macro check
            if ((ch0 === 'i' || thisLine.startsWith('video:') || thisLine.startsWith('audio:'))) {
              const mm = thisLine.match(BlockMediaMacroRx);
              if (mm) {
                const [, blkCtxStr, target0, blkAttrsStr] = mm;
                const blkCtx = blkCtxStr;
                block = new Block(parent, blkCtx, { content_model: 'empty' });
                let target = target0;
                if (blkAttrsStr) {
                  let posattrs = [];
                  if (blkCtx === 'video') posattrs = ['poster', 'width', 'height'];
                  else if (blkCtx === 'image') posattrs = ['alt', 'width', 'height'];
                  await block.parseAttributes(blkAttrsStr, posattrs, { sub_input: true, into: attributes });
                }
                delete attributes['style'];
                if (target.includes(ATTR_REF_HEAD)) {
                  const expanded = block.subAttributes(target, { returnDropSentinel: true });
                  if (expanded === null) {
                    // A missing attribute triggered drop-line; blank attributes (e.g. {blank})
                    // that resolve to '' are kept (expanded !== null for those).
                    for (const k of Object.keys(attributes)) delete attributes[k];
                    return null
                  }
                  target = expanded;
                }
                if (blkCtx === 'image') {
                  document.register('images', target);
                  attributes['imagesdir'] ??= docAttrs['imagesdir'];
                  attributes['alt'] ??= style ?? (attributes['default-alt'] = basename(target, true).replace(/[_-]/g, ' '));
                  let scaledwidth = attributes['scaledwidth'];
                  if (scaledwidth) {
                    delete attributes['scaledwidth'];
                    if (!scaledwidth.match(/\D/)) scaledwidth += '%';
                    attributes['scaledwidth'] = scaledwidth;
                  }
                  if (attributes['title']) {
                    block.title = attributes['title'];
                    delete attributes['title'];
                    block.assignCaption(attributes['caption'], 'figure');
                    delete attributes['caption'];
                  }
                }
                attributes['target'] = target;
                break
              }
            }

            if (ch0 === 't' && thisLine.startsWith('toc:')) {
              const tocm = thisLine.match(BlockTocMacroRx);
              if (tocm) {
                block = new Block(parent, 'toc', { content_model: 'empty' });
                if (tocm[1]) await block.parseAttributes(tocm[1], [], { sub_input: true, into: attributes });
                break
              }
            }

            if (blockMacroExtensions) {
              const cbm = thisLine.match(CustomBlockMacroRx);
              if (cbm) {
                const extension = extensions.registeredForBlockMacro(cbm[1]);
                if (extension) {
                  let target = cbm[2];
                  const content = cbm[3];
                  if (target.includes(ATTR_REF_HEAD)) {
                    const expanded = parent.subAttributes(target, { returnDropSentinel: true });
                    if (expanded === null) {
                      for (const k of Object.keys(attributes)) delete attributes[k];
                      return null
                    }
                    target = expanded;
                  }
                  const extConfig = extension.config;
                  if (extConfig.content_model === 'attributes') {
                    if (content) await document.parseAttributes(content, extConfig.positional_attrs ?? extConfig.pos_attrs ?? [], { sub_input: true, into: attributes });
                  } else {
                    attributes['text'] = content ?? '';
                  }
                  if (extConfig.default_attrs) {
                    for (const [k, v] of Object.entries(extConfig.default_attrs)) {
                      attributes[k] ??= v;
                    }
                  }
                  const result = await extension.processMethod(parent, target, attributes);
                  if (result && result !== parent) {
                    Object.assign(attributes, result.attributes);
                    block = result;
                    break
                  }
                  for (const k of Object.keys(attributes)) delete attributes[k];
                  return null
                }
              }
            }
          }
        }

        if (!indented && (ch0 ?? thisLine[0]) === '<') {
          const clm = thisLine.match(CalloutListRx);
          if (clm) {
            reader.unshiftLine(thisLine);
            block = await Parser.parseCalloutList(reader, clm, parent, document.callouts);
            attributes['style'] = 'arabic';
            break
          }
        }

        if (UnorderedListRx.test(thisLine)) {
          reader.unshiftLine(thisLine);
          if (!style && parent instanceof Section && parent.sectname === 'bibliography') {
            attributes['style'] = 'bibliography';
          }
          block = await Parser.parseList(reader, 'ulist', parent, style ?? attributes['style'] ?? null);
          break
        }

        if (OrderedListRx.test(thisLine)) {
          reader.unshiftLine(thisLine);
          const start = ('start' in attributes) ? attributes['start'] : null;
          delete attributes['start'];
          block = await Parser.parseList(reader, 'olist', parent, style, { start });
          if (block.style) attributes['style'] = block.style;
          break
        }

        if ((thisLine.includes('::') || thisLine.includes(';;'))) {
          const dlm = thisLine.match(DescriptionListRx);
          if (dlm) {
            reader.unshiftLine(thisLine);
            block = await Parser.parseDescriptionList(reader, dlm, parent);
            break
          }
        }

        if ((style === 'float' || style === 'discrete') &&
            (Parser.isSectionTitle(thisLine, await reader.peekLine()) != null
              )) {
          reader.unshiftLine(thisLine);
          const [floatId, floatReftext, blockTitle, floatLevel] = await Parser.parseSectionTitle(reader, document, attributes['id']);
          if (floatReftext) attributes['reftext'] = floatReftext;
          block = new Block(parent, 'floating_title', { content_model: 'empty' });
          block.title = blockTitle;
          delete attributes['title'];
          // Force title resolution while in scope to capture current attribute values (Ruby: parser.rb ~line 939)
          if (blockTitle.includes(ATTR_REF_HEAD)) await block.precomputeTitle();
          if (floatId) {
            block.id = floatId;
          } else if ('sectids' in docAttrs) {
            await block.precomputeTitle();
            block.id = Section.generateId(block.title, document);
          }
          block.level = floatLevel;
          break
        }

        if (style && style !== 'normal') {
          if (PARAGRAPH_STYLES.has(style)) {
            blockContext   = style;
            cloakedContext = 'paragraph';
            reader.unshiftLine(thisLine);
            break
          }
          if (ADMONITION_STYLES.has(style)) {
            blockContext   = 'admonition';
            cloakedContext = 'paragraph';
            reader.unshiftLine(thisLine);
            break
          }
          if (blockExtensions && extensions.registeredForBlock(style, 'paragraph')) {
            blockContext   = style;
            cloakedContext = 'paragraph';
            reader.unshiftLine(thisLine);
            break
          }
          // unknown style; fall through
          if (style && Parser.logger.isDebug()) Parser.logger.debug(Parser.messageWithContext(`unknown style for paragraph: ${style}`, { source_location: reader.cursor }));
        }

        reader.unshiftLine(thisLine);

        if (indented && !style) {
          const contentAdjacent = skipped === 0 ? options.list_type : null;
          const lines = await Parser.readParagraphLines(reader, contentAdjacent, { skip_line_comments: !!textOnly });
          Parser.adjustIndentation(lines);
          if (textOnly || contentAdjacent === 'dlist') {
            block = new Block(parent, 'paragraph', { content_model: 'simple', source: lines, attributes });
          } else {
            block = new Block(parent, 'literal', { content_model: 'verbatim', source: lines, attributes });
          }
        } else {
          const lines = await Parser.readParagraphLines(reader, skipped === 0 && options.list_type, { skip_line_comments: true });
          if (textOnly) {
            if (indented && style === 'normal') Parser.adjustIndentation(lines);
            block = new Block(parent, 'paragraph', { content_model: 'simple', source: lines, attributes });
          } else if (ADMONITION_STYLE_HEADS.has(ch0) && thisLine.includes(':')) {
            const am = thisLine.match(AdmonitionParagraphRx);
            if (am) {
              lines[0] = thisLine.slice(am[0].length);
              const admName = am[1].toLowerCase();
              attributes['name']      = admName;
              attributes['style']     = am[1];
              attributes['textlabel'] = attributes['caption'] ?? docAttrs[`${admName}-caption`];
              delete attributes['caption'];
              block = new Block(parent, 'admonition', { content_model: 'simple', source: lines, attributes });
            } else {
              if (indented && style === 'normal') Parser.adjustIndentation(lines);
              block = new Block(parent, 'paragraph', { content_model: 'simple', source: lines, attributes });
            }
          } else if (ch0 === '>' && thisLine.startsWith('> ')) {
            const mapped = lines.map(line => {
              if (line === '>') return line.slice(1)
              if (line.startsWith('> ')) return line.slice(2)
              return line
            });
            let creditLine = null;
            if (mapped[mapped.length - 1]?.startsWith('-- ')) {
              creditLine = mapped.pop().slice(3);
              while (mapped.length > 0 && mapped[mapped.length - 1] === '') mapped.pop();
            }
            attributes['style'] = 'quote';
            const { Reader: Rdr } = _requireReader();
            block = await Parser.buildBlock('quote', 'compound', false, parent, new Rdr(mapped), attributes);
            if (creditLine) {
              const subsApplied = await block.applySubs(creditLine, ['specialcharacters', 'quotes', 'attributes', 'replacements', 'macros', 'post_replacements']);
              const commaIdx = subsApplied.indexOf(', ');
              const attribution = commaIdx !== -1 ? subsApplied.slice(0, commaIdx) : subsApplied;
              const citetitle = commaIdx !== -1 ? subsApplied.slice(commaIdx + 2) : null;
              if (attribution) attributes['attribution'] = attribution;
              if (citetitle) attributes['citetitle'] = citetitle;
            }
          } else if (ch0 === '"' && lines.length > 1 && lines[lines.length - 1].startsWith('-- ') && lines[lines.length - 2].endsWith('"')) {
            lines[0] = thisLine.slice(1);
            const cred = lines.pop().slice(3);
            while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
            attributes['style'] = 'quote';
            block = new Block(parent, 'quote', { content_model: 'simple', source: lines, attributes });
            const subsApplied = await block.applySubs(cred, ['specialcharacters', 'quotes', 'attributes', 'replacements', 'macros', 'post_replacements']);
            const commaIdx = subsApplied.indexOf(', ');
            const attribution = commaIdx !== -1 ? subsApplied.slice(0, commaIdx) : subsApplied;
            const citetitle = commaIdx !== -1 ? subsApplied.slice(commaIdx + 2) : null;
            if (attribution) attributes['attribution'] = attribution;
            if (citetitle) attributes['citetitle'] = citetitle;
          } else {
            if (indented && style === 'normal') Parser.adjustIndentation(lines);
            block = new Block(parent, 'paragraph', { content_model: 'simple', source: lines, attributes });
          }
          Parser.catalogInlineAnchors(lines.join(LF$1), block, document, reader);
        }
      } while (false) // eslint-disable-line no-constant-condition
    }

    // Delimited block or styled paragraph
    if (!block) {
      switch (blockContext) {
        case 'listing':
        case 'source': {
          const lang = blockContext !== 'source' && !attributes[1] ? (attributes[2] ?? docAttrs['source-language']) : null;
          if (lang) {
            attributes['style']    = 'source';
            attributes['language'] = lang;
            AttributeList.rekey(attributes, [null, null, 'linenums']);
          } else if (blockContext === 'source') {
            AttributeList.rekey(attributes, [null, 'language', 'linenums']);
            if ('source-language' in docAttrs && !('language' in attributes)) {
              attributes['language'] = docAttrs['source-language'];
            }
            if (cloakedContext !== 'listing') attributes['cloaked-context'] = cloakedContext;
          }
          if (!('linenums-option' in attributes) && ('linenums' in attributes || 'source-linenums-option' in docAttrs)) {
            attributes['linenums-option'] = '';
          }
          if (!('indent' in attributes) && 'source-indent' in docAttrs) {
            attributes['indent'] = docAttrs['source-indent'];
          }
          block = await Parser.buildBlock('listing', 'verbatim', terminator, parent, reader, attributes);
          break
        }
        case 'fenced_code': {
          attributes['style'] = 'source';
          const ll = thisLine.length;
          let language = null;
          if (ll > 3) {
            let langPart = thisLine.slice(3);
            const commaIdx = langPart.indexOf(',');
            if (commaIdx >= 0) {
              if (commaIdx > 0) language = langPart.slice(0, commaIdx).trim();
              if (commaIdx < ll - 4) attributes['linenums'] = '';
            } else {
              language = langPart.trimStart();
            }
          }
          if (!language) {
            if ('source-language' in docAttrs) attributes['language'] = docAttrs['source-language'];
          } else {
            attributes['language'] = language;
          }
          attributes['cloaked-context'] = cloakedContext;
          if (!('linenums-option' in attributes) && ('linenums' in attributes || 'source-linenums-option' in docAttrs)) {
            attributes['linenums-option'] = '';
          }
          if (!('indent' in attributes) && 'source-indent' in docAttrs) attributes['indent'] = docAttrs['source-indent'];
          terminator = terminator.slice(0, 3);
          block = await Parser.buildBlock('listing', 'verbatim', terminator, parent, reader, attributes);
          break
        }
        case 'table': {
          const blockCursor = reader.cursor;
          const { Reader: Rdr } = _requireReader();
          const blockReader = new Rdr(
            await reader.readLinesUntil({ terminator, skip_line_comments: true, context: 'table', cursor: 'at_mark' }),
            blockCursor
          );
          if (!terminator.startsWith('|') && !terminator.startsWith('!')) {
            attributes['format'] ??= terminator.startsWith(',') ? 'csv' : 'dsv';
          }
          block = await Parser.parseTable(blockReader, parent, attributes);
          break
        }
        case 'sidebar':
          block = await Parser.buildBlock(blockContext, 'compound', terminator, parent, reader, attributes);
          break
        case 'admonition': {
          const admStyle = attributes['style'] ?? blockContext;
          attributes['name']      = admStyle.toLowerCase();
          attributes['textlabel'] = (attributes['caption'] && delete attributes['caption']) ?? docAttrs[`${attributes['name']}-caption`];
          block = await Parser.buildBlock(blockContext, 'compound', terminator, parent, reader, attributes);
          break
        }
        case 'open':
        case 'abstract':
        case 'partintro':
          block = await Parser.buildBlock('open', 'compound', terminator, parent, reader, attributes);
          break
        case 'literal':
          block = await Parser.buildBlock(blockContext, 'verbatim', terminator, parent, reader, attributes);
          break
        case 'example':
          if ('collapsible-option' in attributes) attributes['caption'] ??= '';
          block = await Parser.buildBlock(blockContext, 'compound', terminator, parent, reader, attributes);
          break
        case 'quote':
        case 'verse':
          AttributeList.rekey(attributes, [null, 'attribution', 'citetitle']);
          block = await Parser.buildBlock(blockContext, blockContext === 'verse' ? 'verbatim' : 'compound', terminator, parent, reader, attributes);
          break
        case 'stem':
        case 'latexmath':
        case 'asciimath':
          if (blockContext === 'stem') {
            attributes['style'] = STEM_TYPE_ALIASES[attributes[2] ?? docAttrs['stem']];
          }
          block = await Parser.buildBlock('stem', 'raw', terminator, parent, reader, attributes);
          break
        case 'pass':
          block = await Parser.buildBlock(blockContext, 'raw', terminator, parent, reader, attributes);
          break
        case 'comment':
          await Parser.buildBlock(blockContext, 'skip', terminator, parent, reader, attributes);
          for (const k of Object.keys(attributes)) delete attributes[k];
          return null
        default: {
          if (!blockExtensions || !(extensions.registeredForBlock(blockContext, cloakedContext))) {
            throw new Error(`Unsupported block type ${blockContext} at ${reader.cursor}`)
          }
          const extension  = extensions.registeredForBlock(blockContext, cloakedContext);
          const extConfig  = extension.config;
          const contentModel = extConfig.content_model;
          if (contentModel !== 'skip') {
            const posAttrs = extConfig.positional_attrs ?? extConfig.pos_attrs;
            if (posAttrs && posAttrs.length > 0) {
              AttributeList.rekey(attributes, [null, ...posAttrs]);
            }
            if (extConfig.default_attrs) {
              for (const [k, v] of Object.entries(extConfig.default_attrs)) {
                attributes[k] ??= v;
              }
            }
            attributes['cloaked-context'] = cloakedContext;
          }
          block = await Parser.buildBlock(blockContext, contentModel, terminator, parent, reader, attributes, { extension });
          if (!block) {
            for (const k of Object.keys(attributes)) delete attributes[k];
            return null
          }
        }
      }
    }

    if (!block) return null

    if (document.sourcemap) block.sourceLocation = reader.cursorAtMark();
    if (attributes['title']) {
      const blockTitle = attributes['title'];
      block.title = blockTitle;
      delete attributes['title'];
      // Force title resolution while in scope to capture current attribute values (Ruby: parser.rb ~line 939)
      if (blockTitle.includes(ATTR_REF_HEAD)) await block.precomputeTitle();
      if (CAPTION_ATTRIBUTE_NAMES[block.context]) {
        block.assignCaption(attributes['caption']);
        delete attributes['caption'];
      }
    }
    block.style = attributes['style'] ?? null;

    const blockId = block.id ?? (block.id = attributes['id'] ?? null);
    if (blockId) {
      if (!document.register('refs', [blockId, block])) {
        Parser.logger.warn(Parser.messageWithContext(`id assigned to block already in use: ${blockId}`, { source_location: reader.cursorAtMark() }));
      }
    }

    if (Object.keys(attributes).length > 0) block.updateAttributes(attributes);
    block.commitSubs();

    if (block.hasSub('callouts')) {
      if (!Parser.catalogCallouts(block.source, document)) block.removeSub('callouts');
    }

    return block
  }

  // Internal: Build a block from reader lines.
  static async buildBlock (blockContext, contentModel, terminator, parent, reader, attributes, options = {}) {
    let skipProcessing, parseAsContentModel;

    if (contentModel === 'skip') {
      skipProcessing    = true;
      parseAsContentModel = 'simple';
    } else if (contentModel === 'raw') {
      skipProcessing    = false;
      parseAsContentModel = 'simple';
    } else {
      skipProcessing    = false;
      parseAsContentModel = contentModel;
    }

    let lines = null, blockReader = null;

    if (terminator == null) {
      if (parseAsContentModel === 'verbatim') {
        lines = await reader.readLinesUntil({ break_on_blank_lines: true, break_on_list_continuation: true });
      } else {
        if (contentModel === 'compound') contentModel = 'simple';
        lines = await Parser.readParagraphLines(reader, false, { skip_line_comments: true, skip_processing: skipProcessing });
      }
    } else if (parseAsContentModel !== 'compound') {
      lines = await reader.readLinesUntil({ terminator, skip_processing: skipProcessing, context: blockContext, cursor: 'at_mark' });
    } else if (terminator === false) {
      blockReader = reader;
    } else {
      const blockCursor = reader.cursor;
      const { Reader: Rdr } = _requireReader();
      blockReader = new Rdr(
        await reader.readLinesUntil({ terminator, skip_processing: skipProcessing, context: blockContext, cursor: 'at_mark' }),
        blockCursor,
        { document: parent.document }
      );
    }

    if (contentModel === 'verbatim') {
      const tabSize    = parseInt(attributes['tabsize'] ?? parent.document.attributes['tabsize'] ?? '0', 10);
      const indent     = attributes['indent'];
      if (indent != null) {
        Parser.adjustIndentation(lines, parseInt(indent, 10), tabSize);
      } else if (tabSize > 0) {
        Parser.adjustIndentation(lines, -1, tabSize);
      }
    } else if (contentModel === 'skip') {
      return null
    }

    let block;
    if (options.extension) {
      const extension = options.extension;
      delete attributes['style'];
      const { Reader: Rdr } = _requireReader();
      const result = await extension.processMethod(parent, blockReader ?? new Rdr(lines), { ...attributes });
      if (!result || result === parent) return null
      block = result;
      Object.assign(attributes, block.attributes);
      if (block.contentModel === 'compound' && block instanceof Block && block.lines.length > 0) {
        contentModel = 'compound';
        blockReader  = new Rdr(block.lines);
      }
    } else {
      block = new Block(parent, blockContext, { content_model: contentModel, source: lines, attributes });
    }

    if (contentModel === 'compound') await Parser.parseBlocks(blockReader, block);

    return block
  }

  // Public: Parse blocks from reader until exhausted.
  static async parseBlocks (reader, parent, attributes = null) {
    while (true) {
      const block = await Parser.nextBlock(reader, parent, attributes ? { ...attributes } : {});
      if (block) parent.blocks.push(block);
      if (!await reader.hasMoreLines()) break
    }
  }

  // Internal: Parse an ordered or unordered list.
  static async parseList (reader, listType, parent, style = null, opts = {}) {
    const start = opts.start != null ? parseInt(opts.start, 10) : null;
    const listAttrs = (start != null && start !== 1) ? { start } : null;
    const listBlock = new List(parent, listType, listAttrs ? { attributes: listAttrs } : {});
    const listRx = ListRxMap[listType];

    while (await reader.hasMoreLines() && listRx.test(await reader.peekLine())) {
      const m = (await reader.peekLine()).match(listRx);
      const listItem = await Parser.parseListItem(reader, listBlock, m, m[1], style);
      if (listItem) listBlock.blocks.push(listItem);
      if (await reader.skipBlankLines() == null) break
    }

    return listBlock
  }

  // Internal: Catalog callouts in text.
  static catalogCallouts (text, document) {
    if (!text.includes('<')) return false
    let found  = false;
    let autonum = 0;
    const rx = new RegExp(CalloutScanRx.source, CalloutScanRx.flags + 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (!m[0].startsWith('\\')) {
        document.callouts.register(m[2] === '.' ? String(++autonum) : m[2]);
      }
      found = true;
    }
    return found
  }

  // Internal: Catalog a single inline anchor.
  static catalogInlineAnchor (id, reftext, node, location, doc = node.document) {
    if (reftext && reftext.includes(ATTR_REF_HEAD)) {
      reftext = doc.subAttributes(reftext);
    }
    const cursor = location?.cursor ? location.cursor : location;
    if (!doc.register('refs', [id, new Inline(node, 'anchor', reftext, { type: 'ref', id })])) {
      Parser.logger.warn(Parser.messageWithContext(`id assigned to anchor already in use: ${id}`, { source_location: cursor }));
    }
  }

  // Internal: Catalog all inline anchors in text.
  static catalogInlineAnchors (text, block, document, reader) {
    if (!text.includes('[[') && !text.includes('anchor:')) return

    new RegExp(InlineAnchorScanRx.source, 'gd' in RegExp.prototype ? 'gdu' : 'gu');
    let m;
    // Reset lastIndex for global search
    InlineAnchorScanRx.lastIndex = 0;
    const globalRx = new RegExp(InlineAnchorScanRx.source, 'gu');
    while ((m = globalRx.exec(text)) !== null) {
      let id, reftext;
      if (m[1]) {
        id = m[1];
        reftext = m[2];
        if (reftext && reftext.includes(ATTR_REF_HEAD)) {
          reftext = document.subAttributes(reftext);
          if (!reftext) continue
        }
      } else {
        id = m[3];
        reftext = m[4];
        if (reftext) {
          if (reftext.includes(']')) reftext = reftext.replace(/\\]/g, ']');
          if (reftext.includes(ATTR_REF_HEAD)) {
            reftext = document.subAttributes(reftext);
            if (!reftext) reftext = null;
          }
        }
      }
      if (!document.register('refs', [id, new Inline(block, 'anchor', reftext, { type: 'ref', id })])) {
        Parser.logger.warn(Parser.messageWithContext(`id assigned to anchor already in use: ${id}`, { source_location: reader.cursorAtMark() }));
      }
    }
  }

  // Internal: Catalog a bibliography inline anchor.
  static catalogInlineBiblioAnchor (id, reftext, node, reader) {
    const displayReftext = reftext != null ? `[${reftext}]` : null;
    if (!node.document.register('refs', [id, new Inline(node, 'anchor', displayReftext, { type: 'bibref', id })])) {
      Parser.logger.warn(Parser.messageWithContext(`id assigned to bibliography anchor already in use: ${id}`, { source_location: reader.cursor }));
    }
  }

  // Internal: Parse a description list.
  static async parseDescriptionList (reader, match, parent) {
    const listBlock = new List(parent, 'dlist');
    const siblingPattern = DescriptionListSiblingRx[match[2]];
    let currentPair = await Parser.parseListItem(reader, listBlock, match, siblingPattern);
    listBlock.blocks.push(currentPair);

    while (await reader.hasMoreLines()) {
      const pLine = await reader.peekLine();
      const nm = pLine.match(siblingPattern);
      if (!nm) break
      const nextPair = await Parser.parseListItem(reader, listBlock, nm, siblingPattern);
      if (currentPair[1]) {
        listBlock.blocks.push((currentPair = nextPair));
      } else {
        currentPair[0].push(nextPair[0][0]);
        currentPair[1] = nextPair[1];
      }
    }

    return listBlock
  }

  // Internal: Parse a callout list.
  static async parseCalloutList (reader, match, parent, callouts) {
    const listBlock = new List(parent, 'colist');
    let nextIndex = 1;
    let autonum   = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!match) {
        const pLine = await reader.peekLine();
        if (!pLine) break
        const nm = pLine.match(CalloutListRx);
        if (!nm) break
        match = nm;
        reader.mark();
      }
      let num = match[1];
      if (num === '.') num = String(++autonum);
      if (num !== String(nextIndex)) {
        Parser.logger.warn(Parser.messageWithContext(`callout list item index: expected ${nextIndex}, got ${num}`, { source_location: reader.cursorAtMark() }));
      }
      const listItem = await Parser.parseListItem(reader, listBlock, match, '<1>');
      if (listItem) {
        listBlock.blocks.push(listItem);
        const coids = callouts.calloutIds(listBlock.blocks.length);
        if (!coids) {
          Parser.logger.warn(Parser.messageWithContext(`no callout found for <${listBlock.blocks.length}>`, { source_location: reader.cursorAtMark() }));
        } else {
          listItem.attributes['coids'] = coids;
        }
      }
      nextIndex++;
      match = null;
    }

    callouts.nextList();
    return listBlock
  }

  // Internal: Parse a list item (ordered, unordered, callout, or description list).
  static async parseListItem (reader, listBlock, match, siblingTrait, style = null) {
    const listType = listBlock.context;
    const dlist    = listType === 'dlist';
    let listTerm, listItem, hasText, sourcemapAssignmentDeferred;

    if (dlist) {
      const termText = match[1];
      listTerm = new ListItem(listBlock, termText);
      if (termText.startsWith('[[')) {
        const am = termText.match(LeadingInlineAnchorRx);
        if (am) Parser.catalogInlineAnchor(am[1], am[2] ?? termText.slice(am[0].length).trimStart(), listTerm, reader);
      }
      const itemText = match[3] ?? null;
      hasText  = !!itemText;
      listItem = new ListItem(listBlock, itemText);
      if (listBlock.document.sourcemap) {
        listTerm.sourceLocation = reader.cursor;
        if (hasText) {
          listItem.sourceLocation = listTerm.sourceLocation;
        } else {
          sourcemapAssignmentDeferred = true;
        }
      }
    } else {
      hasText  = true;
      const itemText = match[2];
      listItem = new ListItem(listBlock, itemText);
      if (listBlock.document.sourcemap) listItem.sourceLocation = reader.cursor;

      if (listType === 'ulist') {
        listItem.marker = siblingTrait;
        if (itemText.startsWith('[')) {
          if (style && style === 'bibliography') {
            const bm = itemText.match(InlineBiblioAnchorRx);
            if (bm) Parser.catalogInlineBiblioAnchor(bm[1], bm[2], listItem, reader);
          } else if (itemText.startsWith('[[')) {
            const am = itemText.match(LeadingInlineAnchorRx);
            if (am) Parser.catalogInlineAnchor(am[1], am[2], listItem, reader);
          } else if (itemText.startsWith('[ ] ') || itemText.startsWith('[x] ') || itemText.startsWith('[*] ')) {
            listBlock.attributes['checklist-option'] = '';
            listItem.attributes['checkbox'] = '';
            if (!itemText.startsWith('[ ')) listItem.attributes['checked'] = '';
            listItem.text = itemText.slice(4);
          }
        }
      } else if (listType === 'olist') {
        const ordinal = listBlock.blocks.length;
        const isFirst = ordinal === 0;
        let validate = true;
        let startAttr = listBlock.attributes['start'];
        let effectiveOrdinal = ordinal;
        if (startAttr != null) {
          effectiveOrdinal += parseInt(startAttr, 10) - 1;
        } else if (isFirst) {
          const startNum = Parser.resolveOrderedListStart(siblingTrait);
          if (startNum !== 1) {
            listBlock.attributes['start'] = startNum;
            effectiveOrdinal += startNum - 1;
            validate = false;
          }
        }
        const [resolvedMarker, implicitStyle] = Parser.resolveOrderedListMarker(siblingTrait, effectiveOrdinal, validate, reader);
        listItem.marker = resolvedMarker;
        if (isFirst && !style) {
          listBlock.style = implicitStyle ?? (ORDERED_LIST_STYLES[resolvedMarker.length - 1] ?? 'arabic');
        }
        if (itemText.startsWith('[[')) {
          const am = itemText.match(LeadingInlineAnchorRx);
          if (am) Parser.catalogInlineAnchor(am[1], am[2], listItem, reader);
        }
      } else { // colist
        listItem.marker = siblingTrait;
        if (itemText.startsWith('[[')) {
          const am = itemText.match(LeadingInlineAnchorRx);
          if (am) Parser.catalogInlineAnchor(am[1], am[2], listItem, reader);
        }
      }
    }

    await reader.readLine();
    const blockCursor = reader.cursor;
    const { Reader: Rdr } = _requireReader();
    const listItemLines = await Parser.readLinesForListItem(reader, listType, siblingTrait, hasText);
    const listItemReader = new Rdr(listItemLines, blockCursor);

    if (await listItemReader.hasMoreLines()) {
      if (sourcemapAssignmentDeferred) listItem.sourceLocation = blockCursor;
      const commentLines = await listItemReader.skipLineComments();
      const subsequentLine = await listItemReader.peekLine();
      if (subsequentLine != null) {
        if (commentLines.length > 0) listItemReader.unshiftLines(commentLines);
        let contentAdjacent = false;
        if (String(subsequentLine) !== '') {
          contentAdjacent = true;
          if (!dlist) hasText = null;
        }
        const block = await Parser.nextBlock(listItemReader, listItem, {}, { text_only: hasText ? null : true, list_type: listType });
        if (block) listItem.blocks.push(block);
        while (await listItemReader.hasMoreLines()) {
          const b = await Parser.nextBlock(listItemReader, listItem, {}, { list_type: listType });
          if (b) listItem.blocks.push(b);
        }
        if (contentAdjacent && listItem.blocks.length > 0 && listItem.blocks[0].context === 'paragraph') {
          listItem.foldFirst();
        }
      }
    }

    return dlist ? [[listTerm], (listItem.hasText() || listItem.blocks.length > 0 ? listItem : null)] : listItem
  }

  // Internal: Collect lines belonging to the current list item.
  static async readLinesForListItem (reader, listType, siblingTrait = null, hasText = true) {
    const buffer = [];
    let continuation = 'inactive';
    let withinNestedList = false;
    let detachedContinuation = null;
    const dlist = listType === 'dlist';
    let thisLine = null;

    while (await reader.hasMoreLines()) {
      thisLine = await reader.readLine();

      if (Parser.isSiblingListItem(thisLine, listType, siblingTrait)) break

      if (thisLine === LIST_CONTINUATION) thisLine = ListContinuationString;

      const prevLine = buffer.length > 0 ? buffer[buffer.length - 1] : null;

      if (isListContinuation(prevLine)) {
        if (continuation === 'inactive') {
          continuation = 'active';
          hasText = true;
          if (!withinNestedList) buffer[buffer.length - 1] = ListContinuationPlaceholder;
        }
        if (isListContinuation(thisLine)) {
          if (continuation !== 'frozen') {
            continuation = 'frozen';
            buffer.push(thisLine);
          }
          thisLine = null;
          continue
        }
      }

      const delimMatch = Parser.isDelimitedBlock(thisLine, true);
      if (delimMatch) {
        if (continuation !== 'active') break
        buffer.push(thisLine);
        const blockLines = await reader.readLinesUntil({ terminator: delimMatch.terminator, read_last_line: true, context: delimMatch.context });
        buffer.push(...blockLines);
        continuation = 'inactive';
      } else if (dlist && continuation !== 'active' && thisLine.startsWith('[') && BlockAttributeLineRx.test(thisLine)) {
        const blockAttributeLines = [thisLine];
        let interrupt = false;
        while (true) {
          const nextLine = await reader.peekLine();
          if (nextLine == null) break
          if (Parser.isDelimitedBlock(nextLine)) { interrupt = true; break }
          if (nextLine === '' || (nextLine.startsWith('[') && BlockAttributeLineRx.test(nextLine))) {
            blockAttributeLines.push(await reader.readLine());
          } else if (AnyListRx.test(nextLine) && !Parser.isSiblingListItem(nextLine, listType, siblingTrait)) {
            buffer.push(...blockAttributeLines);
            break
          } else {
            interrupt = true; break
          }
        }
        if (interrupt) {
          thisLine = null;
          reader.unshiftLines(blockAttributeLines);
          break
        }
      } else if (continuation === 'active' && thisLine !== '') {
        if (LiteralParagraphRx.test(thisLine)) {
          reader.unshiftLine(thisLine);
          if (dlist) {
            const lns = await reader.readLinesUntil({ preserve_last_line: true, break_on_blank_lines: true, break_on_list_continuation: true },
              (line) => Parser.isSiblingListItem(line, listType, siblingTrait));
            buffer.push(...lns);
          } else {
            const lns = await reader.readLinesUntil({ preserve_last_line: true, break_on_blank_lines: true, break_on_list_continuation: true });
            buffer.push(...lns);
          }
          continuation = 'inactive';
        } else if ((thisLine[0] === '.' && BlockTitleRx.test(thisLine)) ||
            (thisLine[0] === '[' && BlockAttributeLineRx.test(thisLine)) ||
            (thisLine[0] === ':' && AttributeEntryRx.test(thisLine))) {
          buffer.push(thisLine);
        } else {
          if (!withinNestedList) {
            const nestedType = NESTABLE_LIST_CONTEXTS.find(ctx => ListRxMap[ctx].test(thisLine));
            if (nestedType) {
              withinNestedList = true;
              if (nestedType === 'dlist' && !thisLine.match(DescriptionListRx)?.[3]) {
                hasText = false;
              }
            }
          }
          buffer.push(thisLine);
          continuation = 'inactive';
        }
      } else if (prevLine !== null && prevLine === '') {
        if (thisLine === '') {
          const skippedLine = await reader.skipBlankLines();
          if (skippedLine == null) { thisLine = null; break }
          thisLine = await reader.readLine();
          if (thisLine == null) break
          if (Parser.isSiblingListItem(thisLine, listType, siblingTrait)) break
        }
        if (String(thisLine) === LIST_CONTINUATION) {
          detachedContinuation = buffer.length;
          buffer.push(ListContinuationString);
        } else if (hasText) {
          if (Parser.isSiblingListItem(thisLine, listType, siblingTrait)) break
          const nestedType = NESTABLE_LIST_CONTEXTS.find(ctx => ListRxMap[ctx].test(thisLine));
          if (nestedType) {
            buffer.push(thisLine);
            withinNestedList = true;
            if (nestedType === 'dlist' && !thisLine.match(DescriptionListRx)?.[3]) hasText = false;
          } else if (LiteralParagraphRx.test(thisLine)) {
            reader.unshiftLine(thisLine);
            if (dlist) {
              const lns = await reader.readLinesUntil({ preserve_last_line: true, break_on_blank_lines: true, break_on_list_continuation: true },
                (line) => Parser.isSiblingListItem(line, listType, siblingTrait));
              buffer.push(...lns);
            } else {
              const lns = await reader.readLinesUntil({ preserve_last_line: true, break_on_blank_lines: true, break_on_list_continuation: true });
              buffer.push(...lns);
            }
          } else {
            break
          }
        } else {
          if (!withinNestedList) buffer.pop();
          buffer.push(thisLine);
          hasText = true;
        }
      } else if (isListContinuation(thisLine)) {
        hasText = true;
        buffer.push(thisLine);
      } else {
        if (thisLine !== '') {
          hasText = true;
          const nestedType = (withinNestedList ? ['dlist'] : NESTABLE_LIST_CONTEXTS).find(ctx => ListRxMap[ctx].test(thisLine));
          if (nestedType) {
            withinNestedList = true;
            if (nestedType === 'dlist' && !thisLine.match(DescriptionListRx)?.[3]) hasText = false;
          }
        }
        buffer.push(thisLine);
      }
      thisLine = null;
    }

    if (thisLine != null) reader.unshiftLine(thisLine);
    if (detachedContinuation != null) buffer[detachedContinuation] = ListContinuationPlaceholder;

    while (buffer.length > 0) {
      const last = buffer[buffer.length - 1];
      if (isListContinuation(last)) { buffer.pop(); break }
      if (last === '') { buffer.pop(); }
      else { break }
    }

    return buffer
  }

  // Internal: Initialize a Section from the current reader position.
  static async initializeSection (reader, parent, attributes = {}) {
    const document  = parent.document;
    const doctype   = document.doctype;
    const book      = doctype === 'book';
    const sourceLocation = document.sourcemap ? reader.cursor : null;
    const sectStyle = attributes[1] ?? null;

    const [sectId, sectReftext, sectTitle, rawSectLevel, sectAtx] = await Parser.parseSectionTitle(reader, document, attributes['id']);
    let sectLevel = rawSectLevel;

    let sectName, sectSpecial = false, sectNumbered = false;
    if (sectStyle) {
      if (book && sectStyle === 'abstract') {
        sectName  = 'chapter';
        // sectLevel already 1 from parseSectionTitle typically
      } else if (sectStyle.startsWith('sect') && SectionLevelStyleRx.test(sectStyle)) {
        sectName = 'section';
      } else {
        sectName    = sectStyle;
        sectSpecial = true;
        if (book && sectLevel === 0) sectLevel = 1;
        sectNumbered = sectName === 'appendix';
      }
    } else if (book) {
      sectName = sectLevel === 0 ? 'part' : (sectLevel > 1 ? 'section' : 'chapter');
    } else if (doctype === 'manpage' && sectTitle.toLowerCase() === 'synopsis') {
      sectName    = 'synopsis';
      sectSpecial = true;
    } else {
      sectName = 'section';
    }

    if (sectReftext) attributes['reftext'] = sectReftext;
    const section = new Section(parent, sectLevel);
    section.id             = sectId ?? null;
    section.title          = sectTitle;
    section.sectname       = sectName;
    section.sourceLocation = sourceLocation;

    if (sectSpecial) {
      section.special = true;
      if (sectNumbered) {
        section.numbered = true;
      } else if (document.attributes['sectnums'] === 'all') {
        section.numbered = book && sectLevel === 1 ? 'chapter' : true;
      }
    } else if (('sectnums' in document.attributes) && sectLevel > 0) {
      section.numbered = section.special ? (parent.numbered && true) : true;
    } else if (book && sectLevel === 0 && ('partnums' in document.attributes)) {
      section.numbered = true;
    }

    let id = section.id;
    if (id != null) {
      if (id === '') {
        section.id = id = null;
      } else if (sectTitle.includes(ATTR_REF_HEAD)) {
        // Force title resolution while in scope, mirroring Ruby's lazy-memo access
        // (`section.title` triggers `@converted_title ||= apply_title_subs(@title)`).
        // Must happen before _restoreAttributes resets body-scoped attribute values.
        await section.precomputeTitle();
      }
    } else if ('sectids' in document.attributes) {
      // Match Ruby behaviour: section.title returns apply_title_subs(@title) (fully substituted HTML).
      // InvalidSectionIdCharsRx then strips the HTML tags, so inline anchors, icon macros and
      // URL macros are correctly excluded from the generated ID.
      // precomputeTitle() is idempotent (guarded by #convertedTitle == null), so calling it here
      // prevents a second substitution pass in _resolveAllTexts (avoids double-cataloging images,
      // footnotes, etc.).
      await section.precomputeTitle();
      section.id = id = Section.generateId(section.title, document);
    }

    if (id && !document.register('refs', [id, section])) {
      const lineNo = reader.lineno - (sectAtx ? 1 : 2);
      Parser.logger.warn(Parser.messageWithContext(`id assigned to section already in use: ${id}`, { source_location: reader.cursorAtLine(lineNo) }));
    }

    section.updateAttributes(attributes);
    await reader.skipBlankLines();

    return section
  }

  // Internal: Check if the next line is a section title.
  //
  // Returns the Integer section level or null.
  static async isNextLineSection (reader, attributes) {
    const style = attributes[1];
    if (style && (style === 'discrete' || style === 'float')) return null

    {
      const nextLines = await reader.peekLines(2, style && style === 'comment');
      return Parser.isSectionTitle(nextLines[0] ?? '', nextLines[1] ?? null)
    }
  }

  // Internal: Check if the next line is the document title.
  static async isNextLineDoctitle (reader, attributes, leveloffset) {
    const sectLevel = await Parser.isNextLineSection(reader, attributes);
    if (sectLevel == null || sectLevel === false) return false
    if (leveloffset) {
      return sectLevel + parseInt(leveloffset, 10) === 0
    }
    return sectLevel === 0
  }

  // Public: Check if line1 (and optionally line2) form a section title.
  //
  // Returns Integer level or null.
  static isSectionTitle (line1, line2 = null) {
    const atxLevel = Parser.atxSectionTitle(line1);
    if (atxLevel != null) return atxLevel
    if (!line2) return null
    return Parser.setextSectionTitle(line1, line2)
  }

  // Check for ATX-style section title.
  static atxSectionTitle (line) {
    const rx = ExtAtxSectionTitleRx ;
    if (!((line.startsWith('=') || line.startsWith('#')) )) return null
    const m = line.match(rx);
    return m ? m[1].length - 1 : null
  }

  // Check for setext-style section title.
  static setextSectionTitle (line1, line2) {
    const ch0   = line2[0];
    const level = SETEXT_SECTION_LEVELS[ch0];
    if (level == null) return null
    if (!_uniform(line2, ch0, line2.length)) return null
    if (!SetextSectionTitleRx.test(line1)) return null
    if (Math.abs(line1.length - line2.length) >= 2) return null
    return level
  }

  // Public: Parse section title from reader.
  //
  // Returns [id, reftext, title, level, atx].
  static async parseSectionTitle (reader, document, sectId = null) {
    let sectReftext = null, sectTitle, sectLevel, atx;

    const line1 = await reader.readLine();
    const rx = ExtAtxSectionTitleRx ;

    if (((line1.startsWith('=') || line1.startsWith('#')) ) && rx.test(line1)) {
      const m = line1.match(rx);
      sectLevel = m[1].length - 1;
      sectTitle = m[2];
      atx       = true;
      if (!sectId && sectTitle.endsWith(']]')) {
        const am = sectTitle.match(InlineSectionAnchorRx);
        if (am && !am[1]) { // not escaped
          sectTitle  = sectTitle.slice(0, sectTitle.length - am[0].length);
          sectId     = am[2];
          sectReftext = am[3] ?? null;
        }
      }
    } else {
      const line2 = await reader.peekLine(true);
      if (line2) {
        const ch0   = line2[0];
        const level = SETEXT_SECTION_LEVELS[ch0];
        if (level != null && _uniform(line2, ch0, line2.length) && SetextSectionTitleRx.test(line1) && Math.abs(line1.length - line2.length) < 2) {
          sectLevel = level;
          const m = line1.match(SetextSectionTitleRx);
          sectTitle = m ? m[1] : line1;
          atx       = false;
          if (!sectId && sectTitle.endsWith(']]')) {
            const am = sectTitle.match(InlineSectionAnchorRx);
            if (am && !am[1]) {
              sectTitle  = sectTitle.slice(0, sectTitle.length - am[0].length);
              sectId     = am[2];
              sectReftext = am[3] ?? null;
            }
          }
          await reader.readLine();
        }
      }
    }

    if (sectTitle == null) {
      throw new Error(`Unrecognized section at ${reader.cursorAtPrevLine()}`)
    }

    const leveloffset = document.attr('leveloffset');
    if (leveloffset) {
      sectLevel += parseInt(leveloffset, 10);
      if (sectLevel < 0) sectLevel = 0;
    }

    return [sectId, sectReftext, sectTitle, sectLevel, atx]
  }

  // Public: Parse header metadata (author line and revision line).
  static async parseHeaderMetadata (reader, document = null, retrieve = true) {
    const docAttrs = document?.attributes;

    await Parser.processAttributeEntries(reader, document);

    let implicitAuthorMetadata = {};
    let authorcount = null;
    let implicitAuthor = null;
    let implicitAuthorinitials = null;
    let implicitAuthors = null;

    if (await reader.hasMoreLines() && !await reader.isNextLineEmpty()) {
      const authorLine = await reader.readLine();
      const parsed     = Parser.processAuthors(authorLine);
      authorcount = parsed['authorcount'];
      delete parsed['authorcount'];
      implicitAuthorMetadata = parsed;
      implicitAuthorMetadata['authorcount'] = authorcount;

      if (document && docAttrs) {
        docAttrs['authorcount'] = authorcount;
        if (authorcount > 0) {
          for (const [key, val] of Object.entries(parsed)) {
            if (!(key in docAttrs)) {
              docAttrs[key] = await document.applyHeaderSubs(val);
            }
          }
          implicitAuthor          = docAttrs['author'];
          implicitAuthorinitials  = docAttrs['authorinitials'];
          implicitAuthors         = docAttrs['authors'];
        }
      }

      await Parser.processAttributeEntries(reader, document);

      if (await reader.hasMoreLines() && !await reader.isNextLineEmpty()) {
        const revLine = await reader.readLine();
        const rm = revLine.match(RevisionInfoLineRx);
        if (rm) {
          const revMetadata = {};
          if (rm[1]) revMetadata['revnumber'] = rm[1].trimEnd();
          if (rm[2]) {
            const component = rm[2].trim();
            if (component !== '') {
              if (!rm[1] && component.startsWith('v')) {
                revMetadata['revnumber'] = component.slice(1);
              } else {
                revMetadata['revdate'] = component;
              }
            }
          }
          if (rm[3]) revMetadata['revremark'] = rm[3].trimEnd();
          if (document && docAttrs && Object.keys(revMetadata).length > 0) {
            for (const [key, val] of Object.entries(revMetadata)) {
              if (!(key in docAttrs)) docAttrs[key] = await document.applyHeaderSubs(val);
            }
          }
          Object.assign(implicitAuthorMetadata, revMetadata);
        } else {
          reader.unshiftLine(revLine);
        }
      }

      await Parser.processAttributeEntries(reader, document);
      await reader.skipBlankLines();
    }

    // Process author attribute entries that override (or stand in for) the implicit author line.
    let authorMetadata = null;
    if (document) {
      if (('author' in docAttrs) && docAttrs['author'] !== implicitAuthor) {
        // author attribute was set or overridden; re-parse as names only (no multiple)
        authorMetadata = Parser.processAuthors(docAttrs['author'], true, false);
        if (docAttrs['authorinitials'] !== implicitAuthorinitials) {
          delete authorMetadata['authorinitials'];
        }
      } else if (('authors' in docAttrs) && docAttrs['authors'] !== implicitAuthors) {
        // authors attribute was set or overridden; re-parse as names only (allow multiple)
        authorMetadata = Parser.processAuthors(docAttrs['authors'], true);
      } else {
        // check for individual author_N overrides
        const authors = [];
        let authorIdx = 1;
        let authorKey = 'author_1';
        let explicit = false;
        let sparse = false;
        while (authorKey in docAttrs) {
          const authorOverride = docAttrs[authorKey];
          if (authorOverride === implicitAuthorMetadata[authorKey]) {
            authors.push(null);
            sparse = true;
          } else {
            authors.push(authorOverride);
            explicit = true;
          }
          authorKey = `author_${++authorIdx}`;
        }
        if (explicit) {
          if (sparse) {
            for (let idx = 0; idx < authors.length; idx++) {
              if (authors[idx] != null) continue
              const nameIdx = idx + 1;
              const parts = [
                implicitAuthorMetadata[`firstname_${nameIdx}`],
                implicitAuthorMetadata[`middlename_${nameIdx}`],
                implicitAuthorMetadata[`lastname_${nameIdx}`],
              ].filter(Boolean).map((n) => n.replace(/ /g, '_'));
              authors[idx] = parts.join(' ');
            }
          }
          // process as names only (no multiple — each entry is already a single author)
          authorMetadata = Parser.processAuthors(authors, true, false);
        } else {
          authorMetadata = { authorcount: 0 };
        }
      }

      if (authorMetadata['authorcount'] === 0) {
        if (authorcount != null) {
          authorMetadata = null;
        } else {
          docAttrs['authorcount'] = 0;
        }
      } else {
        Object.assign(docAttrs, authorMetadata);
        if (!('email' in docAttrs) && ('email_1' in docAttrs)) {
          docAttrs['email'] = docAttrs['email_1'];
        }
      }
    }

    if (!retrieve) return null
    return Object.assign({}, implicitAuthorMetadata, authorMetadata ?? {})
  }

  // Internal: Parse the author line into a metadata Hash.
  static processAuthors (authorLine, namesOnly = false, multiple = true) {
    const authorMetadata = {};
    let authorIdx = 0;
    const entries = (multiple && String(authorLine).includes(';'))
      ? String(authorLine).split(AuthorDelimiterRx)
      : [].concat(authorLine);

    for (const authorEntry of entries) {
      const entry = String(authorEntry);
      if (entry === '') continue
      authorIdx++;

      const keyMap = {};
      if (authorIdx === 1) {
        for (const key of AuthorKeys) keyMap[key] = key;
      } else {
        for (const key of AuthorKeys) keyMap[key] = `${key}_${authorIdx}`;
      }

      let segments = null;
      if (namesOnly) {
        let cleanEntry = entry;
        if (entry.includes('<')) {
          authorMetadata[keyMap['author']] = entry.replace(/_/g, ' ');
          cleanEntry = entry.replace(new RegExp(XmlSanitizeRx.source, 'g'), '');
        }
        // Ruby: split(nil, 3) — splits on whitespace, keeps remainder in 3rd element.
        // JS split with limit drops the remainder, so we split fully then cap at 3.
        const allParts = cleanEntry.split(/\s+/).filter(Boolean);
        const parts = allParts.length > 3
          ? [...allParts.slice(0, 2), allParts.slice(2).join(' ')]
          : allParts;
        if (parts.length === 3) {
          const last = parts.pop();
          parts.push(last.replace(/  +/g, ' '));
        }
        segments = parts;
      } else {
        const m = entry.match(AuthorInfoLineRx);
        if (m) segments = m.slice(1);
      }

      if (segments) {
        const fname = segments[0].replace(/_/g, ' ');
        authorMetadata[keyMap['firstname']]     = fname;
        authorMetadata[keyMap['authorinitials']] = fname[0];
        let author = fname;

        if (segments[1]) {
          if (segments[2]) {
            const mname = segments[1].replace(/_/g, ' ');
            const lname = segments[2].replace(/_/g, ' ');
            authorMetadata[keyMap['middlename']] = mname;
            authorMetadata[keyMap['lastname']]   = lname;
            author = `${fname} ${mname} ${lname}`;
            authorMetadata[keyMap['authorinitials']] = `${fname[0]}${mname[0]}${lname[0]}`;
          } else {
            const lname = segments[1].replace(/_/g, ' ');
            authorMetadata[keyMap['lastname']] = lname;
            author = `${fname} ${lname}`;
            authorMetadata[keyMap['authorinitials']] = `${fname[0]}${lname[0]}`;
          }
        }
        authorMetadata[keyMap['author']] ??= author;
        if (!namesOnly && segments[3]) authorMetadata[keyMap['email']] = segments[3];
      } else {
        const author = entry.replace(/  +/g, ' ').trim();
        authorMetadata[keyMap['author']]         = author;
        authorMetadata[keyMap['firstname']]      = author;
        authorMetadata[keyMap['authorinitials']] = author[0];
      }

      if (authorIdx === 1) {
        authorMetadata['authors'] = authorMetadata[keyMap['author']];
      } else {
        if (authorIdx === 2) {
          for (const key of AuthorKeys) {
            if (key in authorMetadata) authorMetadata[`${key}_1`] = authorMetadata[key];
          }
        }
        authorMetadata['authors'] = `${authorMetadata['authors']}, ${authorMetadata[keyMap['author']]}`;
      }
    }

    authorMetadata['authorcount'] = authorIdx;
    return authorMetadata
  }

  // Internal: Parse block metadata lines.
  static async parseBlockMetadataLines (reader, document, attributes = {}, options = {}) {
    while (await Parser.parseBlockMetadataLine(reader, document, attributes, options)) {
      await reader.readLine();
      if (await reader.skipBlankLines() == null) break
    }
    return attributes
  }

  // Internal: Parse the next line if it contains block metadata.
  //
  // Returns true if the line is metadata, otherwise falsy.
  static async parseBlockMetadataLine (reader, document, attributes, options = {}) {
    const nextLine = await reader.peekLine();
    if (!nextLine) return null

    const textOnly = options.text_only;
    const normal   = !textOnly && (nextLine.startsWith('[') || nextLine.startsWith('.') || nextLine.startsWith('/') || nextLine.startsWith(':'));
    const isAttrOrComment = textOnly ? (nextLine.startsWith('[') || nextLine.startsWith('/')) : normal;

    if (!isAttrOrComment) return null

    if (nextLine.startsWith('[')) {
      if (nextLine.startsWith('[[')) {
        if (nextLine.endsWith(']]')) {
          const m = nextLine.match(BlockAnchorRx);
          if (m) {
            attributes['id'] = m[1];
            if (m[2]) {
              const reftext = m[2];
              attributes['reftext'] = reftext.includes(ATTR_REF_HEAD) ? document.subAttributes(reftext) : reftext;
            }
            return true
          }
        }
      } else if (nextLine.endsWith(']')) {
        const m = nextLine.match(BlockAttributeListRx);
        if (m) {
          const currentStyle = attributes[1];
          const parsed = await document.parseAttributes(m[1], [], { sub_input: true, sub_result: true, into: attributes });
          if (parsed[1]) {
            attributes[1] = Parser.parseStyleAttribute(attributes, reader) ?? currentStyle;
          }
          return true
        }
      }
    } else if (normal && nextLine.startsWith('.')) {
      const m = nextLine.match(BlockTitleRx);
      if (m) {
        attributes['title'] = m[1];
        return true
      }
    } else if (!normal || nextLine.startsWith('/')) {
      if (nextLine === '//') return true
      if (normal && nextLine.startsWith('//') && _uniform(nextLine, '/', nextLine.length)) {
        if (nextLine.length !== 3) {
          await reader.readLinesUntil({ terminator: nextLine, skip_first_line: true, preserve_last_line: true, skip_processing: true, context: 'comment' });
          return true
        }
      } else if (nextLine.startsWith('//') && !nextLine.startsWith('///')) {
        return true
      }
    } else if (normal && nextLine.startsWith(':')) {
      const m = nextLine.match(AttributeEntryRx);
      if (m) {
        await Parser.processAttributeEntry(reader, document, attributes, m);
        return true
      }
    }
    return null
  }

  // Internal: Process consecutive attribute entries.
  static async processAttributeEntries (reader, document, attributes = null) {
    await reader.skipCommentLines();
    while (await Parser.processAttributeEntry(reader, document, attributes)) {
      await reader.readLine();
      await reader.skipCommentLines();
    }
  }

  // Internal: Process a single attribute entry.
  static async processAttributeEntry (reader, document, attributes = null, match = null) {
    if (!match) {
      if (!await reader.hasMoreLines()) return false
      const pLine = await reader.peekLine();
      const m = pLine ? pLine.match(AttributeEntryRx) : null;
      if (!m) return false
      match = m;
    }

    let value = match[2] ?? '';
    if (value === '' || value == null) {
      value = '';
    } else if (value.endsWith(LINE_CONTINUATION) || value.endsWith(LINE_CONTINUATION_LEGACY)) {
      const conStr = value.slice(-2);
      value = value.slice(0, -2).trimEnd();
      while (await reader.advance()) {
        const nextLine = (await reader.peekLine() ?? '');
        if (nextLine === '') break
        let next = nextLine.trimStart();
        const keepOpen = next.endsWith(conStr);
        if (keepOpen) next = next.slice(0, -2).trimEnd();
        value = `${value}${value.endsWith(' +') ? LF$1 : ' '}${next}`;
        if (!keepOpen) break
      }
    }

    // Pre-process pass macros with full async subs (e.g. quotes) before storeAttribute.
    // The sync _applyAttributeValueSubs inside setAttribute cannot handle async subs.
    if (document && value !== '') {
      const passMatch = value.match(AttributeEntryPassMacroRx);
      if (passMatch) {
        value = await document._applyAttributeEntryValueSubs(value);
        Parser.storeAttribute(match[1], value, document, attributes, { skipSubs: true });
        return true
      }
    }

    Parser.storeAttribute(match[1], value, document, attributes);
    return true
  }

  // Public: Store the attribute in the document.
  static storeAttribute (name, value, doc = null, attrs = null, opts = {}) {
    if (name.endsWith('!')) {
      name = name.slice(0, -1);
      value = null;
    } else if (name.startsWith('!')) {
      name = name.slice(1);
      value = null;
    }

    name = Parser.sanitizeAttributeName(name);

    if (name === 'numbered') name = 'sectnums';
    else if (name === 'hardbreaks') name = 'hardbreaks-option';
    else if (name === 'showtitle') {
      // Ruby: '' is truthy so `value ? nil : ''` unsets notitle when showtitle is set.
      // In JS, '' is falsy, so we test value !== null instead.
      Parser.storeAttribute('notitle', value !== null ? null : '', doc, attrs);
    }

    if (doc) {
      if (value != null) {
        if (value !== '') {
          if (name === 'leveloffset') {
            const current = parseInt(doc.attr('leveloffset', 0), 10) || 0;
            if (value.startsWith('+')) value = String(current + parseInt(value.slice(1), 10));
            else if (value.startsWith('-')) value = String(current - parseInt(value.slice(1), 10));
          }
        }
        // value === '' means set to empty string (Ruby: '' is truthy → setAttribute path)
        const resolvedValue = doc.setAttribute(name, value, opts.skipSubs);
        if (resolvedValue != null) {
          value = resolvedValue;
          if (attrs) new AttributeEntry(name, value).saveTo(attrs);
        }
      } else if (doc.deleteAttribute(name) && attrs) {
        new AttributeEntry(name, value).saveTo(attrs);
      }
    } else if (attrs) {
      new AttributeEntry(name, value).saveTo(attrs);
    }

    return [name, value]
  }

  // Internal: Read paragraph lines.
  static async readParagraphLines (reader, breakAtList, opts = {}) {
    opts.break_on_blank_lines     = true;
    opts.break_on_list_continuation = true;
    opts.preserve_last_line       = true;

    // isPlaceholder matches only ListContinuationPlaceholder (empty boxed String), not ListContinuationString ('+').
    // We must not fire on ListContinuationString here because it would be preserved back to the reader,
    // and skipBlankLines would not consume it (String('+') ≠ ''), causing an infinite loop.
    const isPlaceholder = (l) => isListContinuation(l) && String(l) === '';

    let breakCondition = null;
    if (breakAtList) {
      breakCondition = (l) => isPlaceholder(l) || Parser.isDelimitedBlock(l) || (l.startsWith('[') && BlockAttributeLineRx.test(l)) || AnyListRx.test(l)
        ;
    } else {
      breakCondition = (l) => isPlaceholder(l) || (l.startsWith('[') && BlockAttributeLineRx.test(l)) || Parser.isDelimitedBlock(l);
    }

    return await reader.readLinesUntil(opts, breakCondition)
  }

  // Public: Check if line is the start of a delimited block.
  //
  // Returns BlockMatchData object if return_match_data is true, true/false otherwise.
  static isDelimitedBlock (line, returnMatchData = false) {
    let lineLen = line.length;
    if (lineLen < 2 || !DELIMITED_BLOCK_HEADS[line.slice(0, 2)]) return null

    let tip, tipLen;

    if (lineLen === 2) {
      tip    = line;
      tipLen = 2;
    } else {
      tipLen = lineLen < 5 ? lineLen : 4;
      tip    = line.slice(0, tipLen);

      // Fenced code special case
      if (tip.startsWith('`')) {
        if (tipLen === 4) {
          if (tip === '````') return null
          tip = tip.slice(0, 3);
          if (tip !== '```') return null
          // Mirror Ruby: line = tip; line_len = tip_len = 3
          // This ensures the returned terminator is '```', not the full opener line
          // (e.g. '```ruby'), so that readLinesUntil finds the correct closing delimiter.
          line = tip;
          lineLen = tipLen = 3;
        } else if (tip !== '```') {
          return null
        }
      } else if (tipLen === 3) {
        return null
      }
    }

    const entry = DELIMITED_BLOCKS[tip];
    if (!entry) return null
    const [context, masq] = entry;

    const isMatch = lineLen === tipLen || (DELIMITED_BLOCK_TAILS[tip] != null && _uniform(line.slice(1), DELIMITED_BLOCK_TAILS[tip], lineLen - 1));
    if (!isMatch) return null

    return returnMatchData ? { context, masq, tip, terminator: line } : true
  }

  // Internal: Resolve the list marker for a list item.
  static resolveListMarker (listType, marker) {
    if (listType === 'ulist') return marker
    if (listType === 'olist') return Parser.resolveOrderedListMarker(marker)[0]
    return '<1>'
  }

  // Internal: Resolve the normalized ordered list marker.
  static resolveOrderedListMarker (marker, ordinal = null, validate = false, reader = null) {
    if (marker.startsWith('.')) return [marker]

    const style = ORDERED_LIST_STYLES.find(s => OrderedListMarkerRxMap[s].test(marker));
    let normalizedMarker, expected, actual;

    switch (style) {
      case 'arabic':
        if (validate) { expected = String(ordinal + 1); actual = String(parseInt(marker, 10)); }
        normalizedMarker = '1.';
        break
      case 'loweralpha':
        if (validate) { expected = String.fromCharCode(97 + ordinal); actual = marker.slice(0, -1); }
        normalizedMarker = 'a.';
        break
      case 'upperalpha':
        if (validate) { expected = String.fromCharCode(65 + ordinal); actual = marker.slice(0, -1); }
        normalizedMarker = 'A.';
        break
      case 'lowerroman':
        if (validate) { expected = intToRoman(ordinal + 1).toLowerCase(); actual = marker.slice(0, -1); }
        normalizedMarker = 'i)';
        break
      case 'upperroman':
        if (validate) { expected = intToRoman(ordinal + 1); actual = marker.slice(0, -1); }
        normalizedMarker = 'I)';
        break
      default:
        normalizedMarker = marker;
    }

    if (ordinal != null) {
      if (validate && expected !== actual) {
        Parser.logger.warn(Parser.messageWithContext(`list item index: expected ${expected}, got ${actual}`, { source_location: reader?.cursor }));
      }
      return [normalizedMarker, style]
    }
    return [normalizedMarker]
  }

  // Internal: Resolve the start value for an ordered list.
  static resolveOrderedListStart (marker) {
    if (marker.startsWith('.')) return 1
    const style = ORDERED_LIST_STYLES.find(s => OrderedListMarkerRxMap[s].test(marker));
    switch (style) {
      case 'arabic':     return parseInt(marker, 10)
      case 'loweralpha': return marker.slice(0, -1).charCodeAt(0) - 96
      case 'upperalpha': return marker.slice(0, -1).charCodeAt(0) - 64
      case 'lowerroman': return romanToInt(marker.slice(0, -1).toUpperCase())
      case 'upperroman': return romanToInt(marker.slice(0, -1))
      default:           return 1
    }
  }

  // Internal: Check if this line is a sibling list item.
  static isSiblingListItem (line, listType, siblingTrait) {
    if (siblingTrait instanceof RegExp) return siblingTrait.test(line)
    const m = line.match(ListRxMap[listType]);
    if (!m) return false
    const resolvedSibling = Parser.resolveListMarker(listType, siblingTrait);
    return resolvedSibling === Parser.resolveListMarker(listType, m[1])
  }

  // Internal: Parse a table.
  static async parseTable (tableReader, parent, attributes) {
    const table = new Table(parent, attributes);

    let explicitColspecs = false;
    if ('cols' in attributes) {
      const colspecs = Parser.parseColspecs(attributes['cols']);
      if (colspecs.length > 0) {
        table.createColumns(colspecs);
        explicitColspecs = true;
      }
    }

    const skipped = await tableReader.skipBlankLines() ?? 0;
    if ('header-option' in attributes) {
      table.hasHeaderOption = true;
    } else if (skipped === 0 && !('noheader-option' in attributes)) {
      table.hasHeaderOption = 'implicit';
    }
    let implicitHeader = table.hasHeaderOption === 'implicit';

    const parserCtx = new Table.ParserContext(tableReader, table, attributes);
    const format    = parserCtx.format;
    let loopIdx     = -1;
    let implicitHeaderBoundary = null;

    while (true) {
      let line = await tableReader.readLine();
      if (line == null) break

      const beyondFirst = ++loopIdx > 0;
      if (beyondFirst && line === '') {
        line = null;
        if (implicitHeaderBoundary != null) implicitHeaderBoundary++;
      } else if (format === 'psv') {
        if (parserCtx.startsWith(line)) {
          line = line.slice(1);
          await parserCtx.closeOpenCell();
          if (implicitHeaderBoundary != null) implicitHeaderBoundary = null;
        } else {
          const [nextCellspec, rest] = Parser.parseCellspec(line, 'start', parserCtx.delimiter);
          if (nextCellspec != null) {
            await parserCtx.closeOpenCell(nextCellspec);
            if (implicitHeaderBoundary != null) implicitHeaderBoundary = null;
          } else if (implicitHeaderBoundary != null && implicitHeaderBoundary === loopIdx) {
            table.hasHeaderOption = implicitHeader = implicitHeaderBoundary = null;
          }
          line = rest;
        }
      }

      if (!beyondFirst) {
        tableReader.mark();
        if (implicitHeader) {
          if (await tableReader.hasMoreLines() && await tableReader.peekLine() === '') {
            implicitHeaderBoundary = 1;
          } else {
            table.hasHeaderOption = implicitHeader = null;
          }
        }
      }

      // Inner loop for cell delimiter processing
      while (true) {
        if (line != null) {
          const m = line.match(parserCtx.delimiterRe);
          if (m) {
            const preMatch  = line.slice(0, m.index);
            const postMatch = line.slice(m.index + m[0].length);
            if (format === 'csv') {
              if (parserCtx.bufferHasUnclosedQuotes(preMatch)) {
                parserCtx.skipPastDelimiter(preMatch);
                line = postMatch;
                if (line === '') break
                continue
              }
              parserCtx.buffer += preMatch;
            } else if (format === 'dsv') {
              if (preMatch.endsWith('\\')) {
                parserCtx.skipPastEscapedDelimiter(preMatch);
                if (postMatch === '') {
                  parserCtx.buffer += LF$1;
                  parserCtx.keepCellOpen();
                  break
                }
                line = postMatch; continue
              }
              parserCtx.buffer += preMatch;
            } else {
              if (preMatch.endsWith('\\')) {
                parserCtx.skipPastEscapedDelimiter(preMatch);
                if (postMatch === '') {
                  parserCtx.buffer += LF$1;
                  parserCtx.keepCellOpen();
                  break
                }
                line = postMatch; continue
              }
              const [nextSpec, cellText] = Parser.parseCellspec(preMatch);
              parserCtx.pushCellspec(nextSpec);
              parserCtx.buffer += cellText;
            }
            line = postMatch || null;
            await parserCtx.closeCell();
            if (postMatch === '') {
              if (format === 'csv' || format === 'dsv') {
                await parserCtx.closeCell(true);
              } else if (format === 'psv') {
                parserCtx.keepCellOpen();
              }
            }
          } else {
            parserCtx.buffer += line + LF$1;
            if (format === 'csv') {
              if (parserCtx.bufferHasUnclosedQuotes()) {
                if (implicitHeaderBoundary != null && loopIdx === 0) {
                  table.hasHeaderOption = implicitHeader = implicitHeaderBoundary = null;
                }
                parserCtx.keepCellOpen();
              } else {
                await parserCtx.closeCell(true);
              }
            } else if (format === 'dsv') {
              await parserCtx.closeCell(true);
            } else {
              parserCtx.keepCellOpen();
            }
            break
          }
        } else {
          // null line = blank line; preserve in buffer so multi-paragraph cells are detected
          if (format === 'psv' && parserCtx.buffer !== '') {
            parserCtx.buffer += LF$1;
            parserCtx.keepCellOpen();
          } else if (format === 'csv' && parserCtx.isCellOpen()) {
            parserCtx.buffer += LF$1;
          }
          break
        }
      }

      if (parserCtx.isCellOpen()) {
        if (!await tableReader.hasMoreLines()) await parserCtx.closeCell(true);
      } else {
        if (await tableReader.skipBlankLines() == null) break
      }
    }

    await parserCtx.closeTable();
    if ((table.attributes['colcount'] ??= table.columns.length) !== 0 && !explicitColspecs) {
      table.assignColumnWidths();
    }
    if (implicitHeader) table.hasHeaderOption = true;
    await table.partitionHeaderFooter(attributes);

    return table
  }

  // Internal: Parse column specs.
  static parseColspecs (records) {
    records = records.replace(/ /g, '');
    if (!records) return []
    if (records === String(parseInt(records, 10))) {
      return Array.from({ length: parseInt(records, 10) }, () => ({ width: 1 }))
    }
    const specs = [];
    const parts = records.includes(',') ? records.split(',') : records.split(';');
    for (const record of parts) {
      if (record === '') {
        specs.push({ width: 1 });
      } else {
        const m = record.match(ColumnSpecRx);
        if (!m) continue
        const spec = {};
        if (m[2]) {
          const [colspec, rowspec] = m[2].split('.');
          if (colspec && TableCellHorzAlignments[colspec]) spec['halign'] = TableCellHorzAlignments[colspec];
          if (rowspec && TableCellVertAlignments[rowspec]) spec['valign'] = TableCellVertAlignments[rowspec];
        }
        spec['width'] = m[3] ? (m[3] === '~' ? -1 : parseInt(m[3], 10)) : 1;
        if (m[4] && TableCellStyles[m[4]]) spec['style'] = TableCellStyles[m[4]];
        const repeat = m[1] ? parseInt(m[1], 10) : 1;
        for (let i = 0; i < repeat; i++) specs.push({ ...spec });
      }
    }
    return specs
  }

  // Internal: Parse cell spec from line.
  //
  // Returns [spec, rest].
  static parseCellspec (line, pos = 'end', delimiter = null) {
    let m, rest = '';

    if (pos === 'start') {
      if (!line.includes(delimiter)) return [null, line]
      const delimIdx = line.indexOf(delimiter);
      const specPart = line.slice(0, delimIdx);
      rest = line.slice(delimIdx + delimiter.length);
      m = specPart.match(CellSpecStartRx);
      if (!m) return [null, line]
      if (m[0] === '') return [{}, rest]
      if (specPart.trim() === '') return [null, line]
    } else {
      m = line.match(CellSpecEndRx);
      if (!m) return [{}, line]
      if (m[0].trimStart() === '') return [{}, line.trimEnd()]
      rest = line.slice(0, m.index);
    }

    const spec = {};
    if (m[1]) {
      const [colspec, rowspec] = m[1].split('.');
      const cs = colspec ? parseInt(colspec, 10) : 1;
      const rs = rowspec ? parseInt(rowspec, 10) : 1;
      if (m[2] === '+') {
        if (cs !== 1) spec['colspan'] = cs;
        if (rs !== 1) spec['rowspan'] = rs;
      } else if (m[2] === '*') {
        if (cs !== 1) spec['repeatcol'] = cs;
      }
    }
    if (m[3]) {
      const [colspec, rowspec] = m[3].split('.');
      if (colspec && TableCellHorzAlignments[colspec]) spec['halign'] = TableCellHorzAlignments[colspec];
      if (rowspec && TableCellVertAlignments[rowspec]) spec['valign'] = TableCellVertAlignments[rowspec];
    }
    if (m[4] && TableCellStyles[m[4]]) spec['style'] = TableCellStyles[m[4]];

    return [spec, rest]
  }

  // Public: Parse the first positional attribute for style, role, id, and options.
  static parseStyleAttribute (attributes, reader = null) {
    const rawStyle = attributes[1];
    if (!rawStyle || rawStyle.includes(' ') || false) {
      return (attributes['style'] = rawStyle)
    }

    let name   = null;
    let accum  = '';
    const parsed = {};

    for (const c of rawStyle) {
      if (c === '.') {
        Parser._yieldBufferedAttribute(parsed, name, accum, reader);
        accum = '';
        name  = 'role';
      } else if (c === '#') {
        Parser._yieldBufferedAttribute(parsed, name, accum, reader);
        accum = '';
        name  = 'id';
      } else if (c === '%') {
        Parser._yieldBufferedAttribute(parsed, name, accum, reader);
        accum = '';
        name  = 'option';
      } else {
        accum += c;
      }
    }

    if (name) {
      Parser._yieldBufferedAttribute(parsed, name, accum, reader);
      if (parsed['style']) attributes['style'] = parsed['style'];
      if ('id' in parsed) attributes['id'] = parsed['id'];
      if ('role' in parsed) {
        const existing = attributes['role'];
        attributes['role'] = (!existing || existing === '') ? parsed['role'].join(' ') : `${existing} ${parsed['role'].join(' ')}`;
      }
      if ('option' in parsed) {
        for (const opt of parsed['option']) attributes[`${opt}-option`] = '';
      }
      return parsed['style'] ?? null
    }
    return (attributes['style'] = rawStyle)
  }

  static _yieldBufferedAttribute (attrs, name, value, reader) {
    if (name) {
      if (value === '') {
        const msg = `invalid empty ${name} detected in style attribute`;
        if (reader) Parser.logger.warn(Parser.messageWithContext(msg, { source_location: reader.cursorAtPrevLine() }));
        else Parser.logger.warn(msg);
      } else if (name === 'id') {
        if ('id' in attrs) {
          const msg = 'multiple ids detected in style attribute';
          if (reader) Parser.logger.warn(Parser.messageWithContext(msg, { source_location: reader.cursorAtPrevLine() }));
          else Parser.logger.warn(msg);
        }
        attrs['id'] = value;
      } else {
        (attrs[name] ??= []).push(value);
      }
    } else if (value !== '') {
      attrs['style'] = value;
    }
  }

  // Internal: Remove block indentation and optionally expand tabs.
  static adjustIndentation (lines, indentSize = 0, tabSize = 0) {
    if (!lines || lines.length === 0) return

    if (tabSize > 0 && lines.some(l => l.includes('\t'))) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === '' || !line.includes('\t')) continue
        let result = '';
        let spacesAdded = 0;
        let idx = 0;
        for (const c of line) {
          if (c === '\t') {
            const offset = idx + spacesAdded;
            const spaces = tabSize - (offset % tabSize) || tabSize;
            spacesAdded += spaces - 1;
            result += ' '.repeat(spaces);
          } else {
            result += c;
          }
          idx++;
        }
        lines[i] = result;
      }
    }

    if (indentSize < 0) return

    let blockIndent = null;
    for (const line of lines) {
      if (String(line) === '') continue
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent === 0) { blockIndent = null; break }
      if (blockIndent == null || lineIndent < blockIndent) blockIndent = lineIndent;
    }

    if (indentSize === 0) {
      if (blockIndent) {
        for (let i = 0; i < lines.length; i++) {
          if (String(lines[i]) !== '' && !isListContinuation(lines[i])) lines[i] = lines[i].slice(blockIndent);
        }
      }
    } else {
      const newIndent = ' '.repeat(indentSize);
      for (let i = 0; i < lines.length; i++) {
        if (String(lines[i]) !== '' && !isListContinuation(lines[i])) {
          lines[i] = newIndent + (blockIndent ? lines[i].slice(blockIndent) : lines[i]);
        }
      }
    }
  }

  // Internal: Check if string is uniform (all same character).
  static uniform (str, chr, len) {
    if (str.length !== len) return false
    for (const c of str) if (c !== chr) return false
    return true
  }

  // Internal: Convert an attribute name to a legal form.
  static sanitizeAttributeName (name) {
    return name.replace(new RegExp(InvalidAttributeNameCharsRx.source, 'gu'), '').toLowerCase()
  }
}

// Apply logging mixin to the Parser class itself (static methods use it via singleton)
applyLogging(Parser);

// ── Module-level helpers ──────────────────────────────────────────────────────

function _uniform (str, chr, len) {
  return Parser.uniform(str, chr, len)
}

// Lazy reader resolver to break circular dependency
function _requireReader () {
  return _deps['reader.js'] ?? {}
}

const parser = /*#__PURE__*/Object.freeze({
  __proto__: null,
  Parser: Parser
});

// ESM conversion of extensions.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby modules used as mixins → plain JS objects applied via Object.assign.
//   - Ruby :symbols used as keys → plain strings throughout.
//   - Ruby ::Set → JavaScript Set.
//   - Ruby defined? @foo → this._foo !== undefined.
//   - Ruby instance_exec(&block) → block.call(instance) or instance method call.
//   - Ruby singleton_class.enable_dsl → Object.assign(instance, kindClass.DSL).
//   - Ruby class << self → static methods.
//   - Ruby Helpers.resolve_class → typeof fn === 'function' check.
//   - Ruby @@class_var (InlineMacroProcessor.rx_cache) → static property.
//   - Config option keys keep snake_case to match the Ruby/parser convention.
//   - String class-name resolution (e.g. preprocessor 'MyClass') is not supported;
//     pass the class constructor or an instance directly.
//   - Parser.parseBlocks / block.subAttributes / block.assignCaption are forward
//     references; they will be resolved when those modules implement the methods.


// ── DSL Mixins ────────────────────────────────────────────────────────────────

// Internal: Overlays a builder DSL for configuring a Processor instance.
// Applied to a processor instance via Object.assign(instance, DslMixin).
//
// The process() method has dual behaviour (mirrors Ruby's block / no-block):
//   - Called with a single Function argument → stores it as the process block.
//   - Called with non-Function arguments   → invokes the stored process block.
//
// The this context inside a stored process function is bound to the processor
// instance at definition time.
const ProcessorDsl = {
  option (key, value) {
    this.config[key] = value;
  },

  process (...args) {
    if (args.length === 1 && typeof args[0] === 'function') {
      this._processBlock = args[0].bind(this);
    } else if (this._processBlock !== undefined) {
      return this._processBlock(...args)
    } else {
      throw new Error(`${this.constructor.name} #process method called before being registered`)
    }
  },

  processBlockGiven () {
    return this._processBlock !== undefined
  },
};

const DocumentProcessorDsl = {
  ...ProcessorDsl,

  prefer () {
    this.option('position', '>>');
  },

  // alias: prepend is an alternative name for prefer (matches Ruby DSL)
  prepend () {
    this.prefer();
  },
};

const SyntaxProcessorDsl = {
  ...ProcessorDsl,

  named (value) {
    // When applied to a processor instance, set the name directly.
    // When applied to a class (via static enableDsl), store in config.
    if (this instanceof Processor) {
      this.name = value;
    } else {
      this.option('name', value);
    }
  },

  contentModel (value) {
    this.option('content_model', value);
  },

  // alias: parse_content_as
  parseContentAs (value) {
    this.option('content_model', value);
  },

  positionalAttributes (...value) {
    this.option('positional_attrs', value.flat().map(String));
  },

  // alias: name_positional_attributes / positional_attrs
  namePositionalAttributes (...value) {
    this.option('positional_attrs', value.flat().map(String));
  },

  positionalAttrs (...value) {
    this.option('positional_attrs', value.flat().map(String));
  },

  defaultAttributes (value) {
    this.option('default_attrs', value);
  },

  // alias: default_attrs (deprecated)
  defaultAttrs (value) {
    this.option('default_attrs', value);
  },

  // Public: Resolve and register positional attribute names and default values.
  //
  // Accepts any of:
  //   resolve_attributes()             → positional_attrs: [], default_attrs: {}
  //   resolve_attributes('foo', 'bar') → positional maps (Array-style)
  //   resolve_attributes({...})        → positional maps (Object-style)
  //
  // Array-style tokens understand positional-index notation (e.g. '1:name',
  // '@:name') and default-value notation (e.g. 'name=value', '1:name=value').
  resolveAttributes (...args) {
    // Normalise: if 0 or 1 argument given, unwrap into a single value.
    if (args.length <= 1) {
      const first = args.length === 0 ? true : args[0];
      if (typeof first === 'string' || typeof first === 'symbol') {
        args = [first];
      } else {
        args = first;  // true, Array, or plain Object
      }
    }

    if (args === true) {
      this.option('positional_attrs', []);
      this.option('default_attrs', {});
    } else if (Array.isArray(args)) {
      const names = [];
      const defaults = {};
      for (let arg of args) {
        arg = String(arg);
        if (arg.includes('=')) {
          const eqIdx = arg.indexOf('=');
          let name = arg.slice(0, eqIdx);
          const value = arg.slice(eqIdx + 1);
          if (name.includes(':')) {
            const colonIdx = name.indexOf(':');
            const idxStr = name.slice(0, colonIdx);
            name = name.slice(colonIdx + 1);
            const idx = idxStr === '@' ? names.length : parseInt(idxStr, 10);
            names[idx] = name;
          }
          defaults[name] = value;
        } else if (arg.includes(':')) {
          const colonIdx = arg.indexOf(':');
          const idxStr = arg.slice(0, colonIdx);
          const name = arg.slice(colonIdx + 1);
          const idx = idxStr === '@' ? names.length : parseInt(idxStr, 10);
          names[idx] = name;
        } else {
          names.push(arg);
        }
      }
      this.option('positional_attrs', names.filter(n => n != null));
      this.option('default_attrs', defaults);
    } else if (typeof args === 'object' && args !== null) {
      const names = [];
      const defaults = {};
      for (const [key, val] of Object.entries(args)) {
        let name = String(key);
        if (name.includes(':')) {
          const colonIdx = name.indexOf(':');
          const idxStr = name.slice(0, colonIdx);
          name = name.slice(colonIdx + 1);
          const idx = idxStr === '@' ? names.length : parseInt(idxStr, 10);
          names[idx] = name;
        }
        if (val) defaults[name] = val;
      }
      this.option('positional_attrs', names.filter(n => n != null));
      this.option('default_attrs', defaults);
    } else {
      throw new Error(`unsupported attributes specification for macro: ${args}`)
    }
  },

  // alias: resolves_attributes (deprecated)
  resolvesAttributes (...args) {
    this.resolveAttributes(...args);
  },
};

const IncludeProcessorDsl = {
  ...DocumentProcessorDsl,

  handles (...args) {
    if (args.length === 1 && typeof args[0] === 'function') {
      const fn = args[0];
      // Normalise arity-1 handle blocks to accept (doc, target)
      this._handlesBlock = fn.length === 1 ? (_doc, target) => fn(target) : fn.bind(this);
    } else if (this._handlesBlock !== undefined) {
      return this._handlesBlock(args[0], args[1])
    } else {
      return true
    }
  },
};

const DocinfoProcessorDsl = {
  ...DocumentProcessorDsl,

  atLocation (value) {
    this.option('location', value);
  },
};

const BlockProcessorDsl = {
  ...SyntaxProcessorDsl,

  contexts (...value) {
    this.option('contexts', new Set(value.flat()));
  },

  // aliases
  onContexts (...value) { this.contexts(...value); },
  onContext (...value)   { this.contexts(...value); },
  bindTo (...value)      { this.contexts(...value); },
};

const MacroProcessorDsl = {
  ...SyntaxProcessorDsl,

  // Override: passing a falsy value sets content_model to :text instead of
  // configuring positional attributes.
  resolveAttributes (...args) {
    if (args.length === 1 && !args[0]) {
      this.option('content_model', 'text');
    } else {
      SyntaxProcessorDsl.resolveAttributes.call(this, ...args);
      this.option('content_model', 'attributes');
    }
  },

  resolvesAttributes (...args) {
    this.resolveAttributes(...args);
  },
};

const InlineMacroProcessorDsl = {
  ...MacroProcessorDsl,

  format (value) {
    this.option('format', value);
  },

  // alias: match_format
  matchFormat (value) { this.option('format', value); },
  // alias: using_format (deprecated)
  usingFormat (value)  { this.option('format', value); },

  match (value) {
    this.option('regexp', value);
  },
};

// ── Processor ────────────────────────────────────────────────────────────────

// Public: An abstract base class for document and syntax processors.
//
// Provides a class-level config map (via static config / static option) and a
// set of convenience factory methods for creating AST nodes.
class Processor {
  // Public: Get the static configuration map for this processor class.
  // Uses hasOwnProperty to avoid inheriting a parent class's config object
  // through the prototype chain when a subclass first accesses config.
  static get config () {
    if (!Object.prototype.hasOwnProperty.call(this, '_config')) this._config = {};
    return this._config
  }

  // Public: Set a default option value for all instances of this processor class.
  static option (key, value) { this.config[key] = value; }

  // Public: Mix the DSL object for this processor class into its prototype.
  static enableDsl () {
    const DSL = this.DSL;
    if (DSL) Object.assign(this.prototype, DSL);
  }
  static useDsl () { this.enableDsl(); }

  // Public: Get the configuration Object for this processor instance.
  // config

  constructor (config = {}) {
    this.config = { ...this.constructor.config, ...config };
  }

  updateConfig (config) {
    Object.assign(this.config, config);
  }

  process (..._args) {
    throw new Error(`${this.constructor.name} subclass must implement the process method`)
  }

  // Public: Creates a new Section node.
  //
  // Creates a Section node in the same manner as the parser.
  //
  // parent - The parent Section (or Document) of this new Section.
  // title  - The String title of the new Section.
  // attrs  - A plain object of attributes to control how the section is built.
  //          Use the style attribute to set the name of a special section (e.g. appendix).
  //          Use the id attribute to assign an explicit ID, or set it to false to
  //          disable automatic ID generation (when sectids document attribute is set).
  // opts   - An optional plain object of options (default: {}):
  //          level    - The Integer level to assign; defaults to parent.level + 1.
  //          numbered - Boolean flag to force numbering.
  //
  // Returns a Section node with all properties properly initialized.
  createSection (parent, title, attrs, opts = {}) {
    const doc = parent.document;
    const doctype = doc.doctype;
    const book = doctype === 'book';
    const level = opts.level ?? (parent.level + 1);

    let sectname, special = false;
    const style = attrs.style;
    if (style) {
      delete attrs.style;
      if (book && style === 'abstract') {
        sectname = 'chapter';
        // level intentionally set to 1 (overrides local const)
        Object.defineProperty(opts, '_level', { value: 1 });
      } else {
        sectname = style;
        special = true;
      }
    } else if (book) {
      sectname = level === 0 ? 'part' : (level > 1 ? 'section' : 'chapter');
    } else if (doctype === 'manpage' && title.toLowerCase() === 'synopsis') {
      sectname = 'synopsis';
      special = true;
    } else {
      sectname = 'section';
    }

    // Re-derive level if style forced it (appendix/abstract style override)
    const effectiveLevel = (style && book && style === 'abstract') ? 1
      : (style && special && level === 0) ? 1
      : level;

    const sect = new Section(parent, effectiveLevel);
    sect.title = title;
    sect.sectname = sectname;

    if (special) {
      sect.special = true;
      if ('numbered' in opts ? opts.numbered : style === 'appendix') {
        sect.numbered = true;
      } else if (!('numbered' in opts) && doc.hasAttr('sectnums', 'all')) {
        sect.numbered = (book && effectiveLevel === 1) ? 'chapter' : true;
      }
    } else if (effectiveLevel > 0) {
      if ('numbered' in opts ? opts.numbered : doc.hasAttr('sectnums')) {
        sect.numbered = sect.special ? !!(parent.numbered) : true;
      }
    } else if ('numbered' in opts ? opts.numbered : (book && doc.hasAttr('partnums'))) {
      sect.numbered = true;
    }

    if (attrs.id === false) {
      delete attrs.id;
    } else {
      sect.id = attrs.id = attrs.id
        || (doc.hasAttr('sectids') ? Section.generateId(sect.title, doc) : null);
    }
    sect.updateAttributes(attrs);
    return sect
  }

  createBlock (parent, context, source, attrs, opts = {}) {
    return new Block(parent, context, { source, attributes: attrs, ...opts })
  }

  // Public: Creates a list node and links it to the specified parent.
  //
  // parent  - The parent Block (Block, Section, or Document) of this new list.
  // context - The list context ('ulist', 'olist', 'colist', 'dlist').
  // attrs   - A plain object of attributes to set on this list block.
  //
  // Returns a List node with all properties properly initialized.
  createList (parent, context, attrs = null) {
    const list = new List(parent, context);
    if (attrs) list.updateAttributes(attrs);
    return list
  }

  // Public: Creates a list item node and links it to the specified parent.
  //
  // parent - The parent List of this new list item block.
  // text   - The text of the list item.
  //
  // Returns a ListItem node with all properties properly initialized.
  createListItem (parent, text = null) {
    return new ListItem(parent, text)
  }

  // Public: Creates an image block node and links it to the specified parent.
  //
  // parent - The parent Block (Block, Section, or Document) of this new image block.
  // attrs  - A plain object of attributes to control how the image block is built.
  //          The target attribute sets the image source; alt sets the alt text.
  // opts   - An optional plain object of options (default: {}).
  //
  // Returns a Block node with all properties properly initialized.
  createImageBlock (parent, attrs, opts = {}) {
    const target = attrs.target;
    if (!target) throw new Error('Unable to create an image block, target attribute is required')
    if (!attrs.alt) attrs.alt = attrs['default-alt'] = basename(target, true).replace(/[_-]/g, ' ');
    const title = 'title' in attrs ? attrs.title : null;
    if (title !== null) delete attrs.title;
    const block = this.createBlock(parent, 'image', null, attrs, opts);
    if (title) {
      block.title = title;
      const caption = attrs.caption;
      delete attrs.caption;
      block.assignCaption(caption, 'figure');
    }
    return block
  }

  // Public: Creates an inline node and binds it to the specified parent.
  //
  // parent  - The parent Block of this new inline node.
  // context - The context of the inline node ('quoted', 'anchor', etc.).
  // text    - The text of the inline node.
  // opts    - An optional plain object of options (default: {}):
  //           type       - The subtype of the inline node context.
  //           attributes - Attributes to set on the inline node.
  //
  // Returns an Inline node with all properties properly initialized.
  createInline (parent, context, text, opts = {}) {
    const options = context === 'quoted' ? { type: 'unquoted', ...opts } : opts;
    return new Inline(parent, context, text, options)
  }

  // Public: Parses blocks in the content and attaches them to the parent.
  //
  // Returns the parent node into which the blocks are parsed.
  async parseContent (parent, content, attributes = null) {
    const reader = content instanceof Reader ? content : new Reader(content);
    await Parser.parseBlocks(reader, parent, attributes);
    return parent
  }

  // Public: Parses the attrlist String into a plain object of attributes.
  //
  // block    - The current AbstractBlock (used for applying subs).
  // attrlist - The list of attributes as a String.
  // opts     - An optional plain object of options:
  //            positional_attributes - Array of attribute names to map positional args to.
  //            sub_attributes        - Enables attribute substitution on attrlist.
  //
  // Returns a plain object of parsed attributes.
  async parseAttributes (block, attrlist, opts = {}) {
    if (!attrlist || attrlist.length === 0) return {}
    if (opts.sub_attributes && attrlist.includes(ATTR_REF_HEAD)) {
      attrlist = block.subAttributes(attrlist);
    }
    return new AttributeList(attrlist).parse(opts.positional_attributes || [])
  }

  // Convenience factory methods that delegate to createBlock / createInline
  // with a fixed context.
  createParagraph (parent, ...rest)    { return this.createBlock(parent, 'paragraph', ...rest) }
  createOpenBlock (parent, ...rest)    { return this.createBlock(parent, 'open', ...rest) }
  createExampleBlock (parent, ...rest) { return this.createBlock(parent, 'example', ...rest) }
  createPassBlock (parent, ...rest)    { return this.createBlock(parent, 'pass', ...rest) }
  createListingBlock (parent, ...rest) { return this.createBlock(parent, 'listing', ...rest) }
  createLiteralBlock (parent, ...rest) { return this.createBlock(parent, 'literal', ...rest) }
  createAnchor (parent, ...rest)       { return this.createInline(parent, 'anchor', ...rest) }
  createInlinePass (parent, ...rest)   { return this.createInline(parent, 'quoted', ...rest) }
}

// ── Document processors ───────────────────────────────────────────────────────

// Public: Preprocessors are run after the source text is split into lines and
// normalised, but before parsing begins.
//
// Asciidoctor passes the document and the document's Reader to the process
// method of the Preprocessor instance. The Preprocessor can modify the Reader
// as necessary and either return the same Reader (or falsy) or a substitute Reader.
//
// Preprocessor implementations must extend Preprocessor.
class Preprocessor extends Processor {
  process (_document, _reader) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }
}
Preprocessor.DSL = DocumentProcessorDsl;

// Public: TreeProcessors are run on the Document after the source has been
// parsed into an abstract syntax tree (AST).
//
// TreeProcessor implementations must extend TreeProcessor.
class TreeProcessor extends Processor {
  process (_document) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }
}
TreeProcessor.DSL = DocumentProcessorDsl;

// Alias deprecated class name for backwards compatibility.
const Treeprocessor = TreeProcessor;

// Public: Postprocessors are run after the document is converted, but before
// it is written to the output stream.
//
// Postprocessor implementations must extend Postprocessor.
class Postprocessor extends Processor {
  process (_document, _output) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }
}
Postprocessor.DSL = DocumentProcessorDsl;

// Public: IncludeProcessors handle include::<target>[] directives.
//
// IncludeProcessor implementations must extend IncludeProcessor.
class IncludeProcessor extends Processor {
  process (_document, _reader, _target, _attributes) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }

  handles (_doc, _target) {
    return true
  }
}
IncludeProcessor.DSL = IncludeProcessorDsl;

// Public: DocinfoProcessors add additional content to the header and/or footer
// of the generated document.
//
// DocinfoProcessor implementations must extend DocinfoProcessor.
class DocinfoProcessor extends Processor {
  constructor (config = {}) {
    super(config);
    this.config.location ??= 'head';
  }

  process (_document) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }
}
DocinfoProcessor.DSL = DocinfoProcessorDsl;

// ── Syntax processors ─────────────────────────────────────────────────────────

// Public: BlockProcessors handle delimited blocks and paragraphs with a custom name.
//
// BlockProcessor implementations must extend BlockProcessor.
class BlockProcessor extends Processor {
  // Public: Get/Set the name of the block handled by this processor.
  // name

  constructor (name = null, config = {}) {
    super(config);
    this.name = name || this.config.name || null;

    // Normalise contexts config to a Set.
    const ctx = this.config.contexts;
    if (ctx == null) {
      this.config.contexts = new Set(['open', 'paragraph']);
    } else if (typeof ctx === 'string') {
      this.config.contexts = new Set([ctx]);
    } else if (Array.isArray(ctx)) {
      this.config.contexts = new Set(ctx);
    }

    this.config.content_model ??= 'compound';
  }

  process (_parent, _reader, _attributes) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }
}
BlockProcessor.DSL = BlockProcessorDsl;

// Internal: Base class shared by BlockMacroProcessor and InlineMacroProcessor.
class MacroProcessor extends Processor {
  // Public: Get/Set the name of the macro handled by this processor.
  // name

  constructor (name = null, config = {}) {
    super(config);
    this.name = name || this.config.name || null;
    this.config.content_model ??= 'attributes';
  }

  process (_parent, _target, _attributes) {
    throw new Error(`${this.constructor.name} must implement the process method`)
  }
}

// Public: BlockMacroProcessors handle block macros with a custom name.
//
// BlockMacroProcessor implementations must extend BlockMacroProcessor.
class BlockMacroProcessor extends MacroProcessor {
  // Getter validates the name; setter just stores it so construction never throws.
  get name () {
    if (this._name != null && !MacroNameRx.test(String(this._name))) {
      throw new Error(`invalid name for block macro: ${this._name}`)
    }
    return this._name
  }

  set name (value) {
    this._name = value;
  }
}
BlockMacroProcessor.DSL = MacroProcessorDsl;

// Public: InlineMacroProcessors handle inline macros with a custom name.
//
// InlineMacroProcessor implementations must extend InlineMacroProcessor.
class InlineMacroProcessor extends MacroProcessor {
  static rxCache = new Map()

  // Lookup (and memoize) the regexp for this inline macro processor.
  get regexp () {
    return this.config.regexp ??= this.resolveRegexp(String(this.name), this.config.format)
  }

  resolveRegexp (name, format) {
    if (!MacroNameRx.test(name)) {
      throw new Error(`invalid name for inline macro: ${name}`)
    }
    const key = `${name}:${format}`;
    if (!InlineMacroProcessor.rxCache.has(key)) {
      const targetPart = format === 'short' ? '(){0}' : '(\\S+?)';
      InlineMacroProcessor.rxCache.set(
        key,
        new RegExp(`\\\\?${name}:${targetPart}\\[(|(?:${CC_ANY})*?(?<!\\\\))\\]`)
      );
    }
    return InlineMacroProcessor.rxCache.get(key)
  }
}
InlineMacroProcessor.DSL = InlineMacroProcessorDsl;

// ── Extension proxy objects ───────────────────────────────────────────────────

// Public: A proxy that encapsulates the extension kind, config, and instance.
// This is what gets stored in the extension registry when activated.
class Extension {
  constructor (kind, instance, config) {
    this.kind = kind;
    this.instance = instance;
    this.config = config;
  }
}

// Public: A specialisation of Extension that additionally stores a reference
// to the process method, accommodating both class-based processors and function blocks.
class ProcessorExtension extends Extension {
  constructor (kind, instance, processMethod = null) {
    super(kind, instance, instance.config);
    this.processMethod = processMethod || ((...args) => instance.process(...args));
  }
}

// ── Group ─────────────────────────────────────────────────────────────────────

// Public: A Group registers one or more extensions with a Registry.
//
// Subclass Group and pass the subclass to Extensions.register(), or call
// the static register() method directly.
class Group {
  static register (name = null) {
    Extensions.register(name, this);
  }

  activate (_registry) {
    throw new Error(`${this.constructor.name} must implement the activate method`)
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

// Internal: Maps kind name → document-processor class.
const DOCUMENT_PROCESSOR_CLASSES = {
  preprocessor:       Preprocessor,
  tree_processor:     TreeProcessor,
  postprocessor:      Postprocessor,
  include_processor:  IncludeProcessor,
  docinfo_processor:  DocinfoProcessor,
};

// Internal: Maps kind name → syntax-processor class.
const SYNTAX_PROCESSOR_CLASSES = {
  block:        BlockProcessor,
  block_macro:  BlockMacroProcessor,
  inline_macro: InlineMacroProcessor,
};

// Public: The primary entry point into the extension system.
//
// Registry holds the extensions which have been registered and activated, has
// methods for registering or defining a processor and looks up extensions
// stored in the registry during parsing.
class Registry {
  // Public: Returns the Document on which extensions in this registry are used.
  // document

  // Public: Returns the plain Object of Group classes, instances, and/or
  // Functions that have been registered with this registry.
  // groups

  constructor (groups = {}) {
    this.groups = groups;
    this._reset();
  }

  // Public: Activates all global extension Groups and the Groups associated
  // with this registry.
  //
  // document - The Document on which the extensions are to be used.
  //
  // Returns this Registry.
  activate (document) {
    if (this.document) this._reset();
    this.document = document;
    const extGroups = [
      ...Object.values(Extensions.groups()),
      ...Object.values(this.groups),
    ];
    for (const group of extGroups) {
      if (typeof group === 'function') {
        // Check if it is a class (constructor) with an activate prototype method.
        if (group.prototype && typeof group.prototype.activate === 'function') {
          new group().activate(this);
        } else {
          // Plain function — call in the context of this registry (like instance_exec).
          group.length === 0 ? group.call(this) : group(this);
        }
      } else if (group && typeof group.activate === 'function') {
        group.activate(this);
      }
    }
    return this
  }

  // Public: Registers a Preprocessor with the extension registry.
  //
  // The processor may be:
  //   - A Preprocessor subclass (constructor function)
  //   - An instance of a Preprocessor subclass
  //   - A Function that configures the processor via the DSL (block style)
  //
  // Examples
  //
  //   // class style
  //   preprocessor(FrontMatterPreprocessor)
  //
  //   // instance style
  //   preprocessor(new FrontMatterPreprocessor())
  //
  //   // block style
  //   preprocessor(function () {
  //     this.process(function (doc, reader) { ... })
  //   })
  //
  // Returns the Extension stored in the registry that proxies this Preprocessor.
  preprocessor (...args) {
    return this._addDocumentProcessor('preprocessor', args)
  }

  // Public: Checks whether any Preprocessor extensions have been registered.
  preprocessors () { return this._preprocessor_extensions }
  hasPreprocessors () { return !!this._preprocessor_extensions }
  // Core API compatibility: expose extensions as a named property.
  get preprocessor_extensions () { return this._preprocessor_extensions }

  // Public: Registers a TreeProcessor with the extension registry.
  treeProcessor (...args) {
    return this._addDocumentProcessor('tree_processor', args)
  }

  // Aliases (deprecated names + snake_case for prefer() / Registry method dispatch).
  treeprocessor (...args) { return this.treeProcessor(...args) }
  tree_processor (...args) { return this.treeProcessor(...args) }

  treeProcessors () { return this._tree_processor_extensions }
  hasTreeProcessors () { return !!this._tree_processor_extensions }
  // hasTeeProcessors kept for backward compatibility (was a typo).
  hasTeeProcessors () { return !!this._tree_processor_extensions }
  treeprocessors () { return this._tree_processor_extensions }
  // Core API compatibility: expose extensions as a named property.
  get tree_processor_extensions () { return this._tree_processor_extensions }

  // Public: Registers a Postprocessor with the extension registry.
  postprocessor (...args) {
    return this._addDocumentProcessor('postprocessor', args)
  }

  postprocessors () { return this._postprocessor_extensions }
  hasPostprocessors () { return !!this._postprocessor_extensions }
  // Core API compatibility: expose extensions as a named property.
  get postprocessor_extensions () { return this._postprocessor_extensions }

  // Public: Registers an IncludeProcessor with the extension registry.
  includeProcessor (...args) {
    return this._addDocumentProcessor('include_processor', args)
  }

  includeProcessors () { return this._include_processor_extensions }
  hasIncludeProcessors () { return !!this._include_processor_extensions }
  include_processor (...args) { return this.includeProcessor(...args) }
  // Core API compatibility: expose extensions as a named property.
  get include_processor_extensions () { return this._include_processor_extensions }

  // Public: Registers a DocinfoProcessor with the extension registry.
  docinfoProcessor (...args) {
    return this._addDocumentProcessor('docinfo_processor', args)
  }

  // Public: Checks whether any DocinfoProcessor extensions have been registered.
  //
  // location - Optional String ('head' or 'footer') to filter by location.
  //
  // Returns a Boolean.
  hasDocinfoProcessors (location = null) {
    if (!this._docinfo_processor_extensions) return false
    if (location) {
      return this._docinfo_processor_extensions.some(ext => ext.config.location === location)
    }
    return true
  }

  // Public: Retrieves Extension proxy objects for DocinfoProcessor instances.
  //
  // location - Optional String ('head' or 'footer') to filter by location.
  //
  // Returns an Array of Extension proxy objects.
  docinfoProcessors (location = null) {
    if (!this._docinfo_processor_extensions) return []
    if (location) {
      return this._docinfo_processor_extensions.filter(ext => ext.config.location === location)
    }
    return this._docinfo_processor_extensions
  }

  docinfo_processor (...args) { return this.docinfoProcessor(...args) }
  // Core API compatibility: expose extensions as a named property.
  get docinfo_processor_extensions () { return this._docinfo_processor_extensions }

  // Public: Registers a BlockProcessor with the extension registry.
  //
  // Examples
  //
  //   // class style
  //   block(ShoutBlock)
  //
  //   // class style with explicit name
  //   block(ShoutBlock, 'shout')
  //
  //   // block style
  //   block(function () {
  //     this.named('shout')
  //     this.process(function (parent, reader, attrs) { ... })
  //   })
  //
  //   // block style with explicit name
  //   block('shout', function () {
  //     this.process(function (parent, reader, attrs) { ... })
  //   })
  //
  // Returns an Extension proxy object.
  block (...args) {
    return this._addSyntaxProcessor('block', args)
  }

  // Public: Checks whether any BlockProcessor extensions have been registered.
  hasBlocks () { return !!this._block_extensions }

  // Public: Checks whether a BlockProcessor is registered for the given name and context.
  //
  // Returns the Extension proxy or false.
  registeredForBlock (name, context) {
    const ext = this._block_extensions?.[String(name)];
    return ext ? (ext.config.contexts.has(context) && ext) : false
  }

  // Public: Retrieves the Extension proxy for the BlockProcessor registered with name.
  findBlockExtension (name) {
    return this._block_extensions?.[String(name)] ?? null
  }

  // Public: Registers a BlockMacroProcessor with the extension registry.
  blockMacro (...args) {
    return this._addSyntaxProcessor('block_macro', args)
  }

  // Alias deprecated method name.
  block_macro (...args) { return this.blockMacro(...args) }

  hasBlockMacros () { return !!this._block_macro_extensions }

  // Public: Checks whether a BlockMacroProcessor is registered for the given name.
  registeredForBlockMacro (name) {
    return this._block_macro_extensions?.[String(name)] || false
  }

  findBlockMacroExtension (name) {
    return this._block_macro_extensions?.[String(name)] ?? null
  }

  // Public: Registers an InlineMacroProcessor with the extension registry.
  inlineMacro (...args) {
    return this._addSyntaxProcessor('inline_macro', args)
  }

  // Alias deprecated method name.
  inline_macro (...args) { return this.inlineMacro(...args) }

  hasInlineMacros () { return !!this._inline_macro_extensions }

  // Public: Checks whether an InlineMacroProcessor is registered for the given name.
  registeredForInlineMacro (name) {
    return this._inline_macro_extensions?.[String(name)] || false
  }

  findInlineMacroExtension (name) {
    return this._inline_macro_extensions?.[String(name)] ?? null
  }

  // Public: Retrieves all InlineMacroProcessor Extension proxy objects.
  inlineMacros () {
    return this._inline_macro_extensions ? Object.values(this._inline_macro_extensions) : []
  }

  // Public: Inserts the document-processor Extension as the first of its kind
  // in the extension registry.
  //
  // Examples
  //
  //   registry.prefer('includeProcessor', function () {
  //     this.process(function (document, reader, target, attrs) { ... })
  //   })
  //
  // Returns the Extension stored in the registry.
  prefer (...args) {
    const arg0 = args.shift();
    let extension;
    if (arg0 instanceof ProcessorExtension) {
      extension = arg0;
    } else {
      // arg0 is a method name; remaining args include the processor and optional block.
      extension = this[arg0](...args);
    }
    const storeKey = `_${extension.kind}_extensions`;
    const store = this[storeKey];
    if (Array.isArray(store)) {
      const idx = store.indexOf(extension);
      if (idx > -1) store.splice(idx, 1);
      store.unshift(extension);
    }
    return extension
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _addDocumentProcessor (kind, args) {
    const kindName = kind.replace(/_/g, ' ');
    const kindClass = DOCUMENT_PROCESSOR_CLASSES[kind];
    if (!this[`_${kind}_extensions`]) this[`_${kind}_extensions`] = [];
    const store = this[`_${kind}_extensions`];

    // Detect block style: last argument is a function that is NOT a class constructor.
    // Class constructors (ES6 classes) have a non-writable prototype descriptor;
    // plain functions (used as DSL blocks) have a writable prototype.
    const lastArg = args[args.length - 1];
    const hasBlock = args.length > 0 && typeof lastArg === 'function'
      && !!(Object.getOwnPropertyDescriptor(lastArg, 'prototype')?.writable ?? true);

    let processorInstance;

    if (hasBlock) {
      const block = args.pop();
      const config = this._resolveArgs(args, 1);
      const processor = new kindClass(config);
      Object.assign(processor, kindClass.DSL);
      block.length === 0 ? block.call(processor) : block(processor);
      if (!processor.processBlockGiven()) {
        throw new Error(`No block specified to process ${kindName} extension`)
      }
      processorInstance = processor;
    } else {
      const [processorArg, config] = this._resolveArgs(args, 2);
      if (typeof processorArg === 'function') {
        // Style 2: class constructor
        if (!(processorArg.prototype instanceof kindClass)) {
          throw new Error(`Invalid type for ${kindName} extension: ${processorArg}`)
        }
        processorInstance = new processorArg(config);
      } else if (processorArg instanceof kindClass) {
        // Style 3: already an instance
        processorArg.updateConfig(config);
        processorInstance = processorArg;
      } else {
        throw new Error(`Invalid arguments specified for registering ${kindName} extension: ${args}`)
      }
    }

    // Apply legacy handles adapter for IncludeProcessors with arity-1 handles method.
    if (kind === 'include_processor') {
      const handlesFn = processorInstance.handles;
      if (typeof handlesFn === 'function' && handlesFn.length === 1) {
        const original = handlesFn.bind(processorInstance);
        processorInstance.handles = (_doc, target) => original(target);
      }
    }

    const extension = new ProcessorExtension(kind, processorInstance);
    extension.config.position === '>>' ? store.unshift(extension) : store.push(extension);
    return extension
  }

  _addSyntaxProcessor (kind, args) {
    const kindName = kind.replace(/_/g, ' ');
    const kindClass = SYNTAX_PROCESSOR_CLASSES[kind];
    if (!this[`_${kind}_extensions`]) this[`_${kind}_extensions`] = Object.create(null);
    const store = this[`_${kind}_extensions`];

    // Detect block style (same heuristic as _addDocumentProcessor).
    const lastArg = args[args.length - 1];
    const hasBlock = args.length > 0 && typeof lastArg === 'function'
      && !!(Object.getOwnPropertyDescriptor(lastArg, 'prototype')?.writable ?? true);

    let processorInstance, name;

    if (hasBlock) {
      const block = args.pop();
      const [nameArg, config] = this._resolveArgs(args, 2);
      const processor = new kindClass(this._asSymbol(nameArg), config);
      Object.assign(processor, kindClass.DSL);
      block.length === 0 ? block.call(processor) : block(processor);
      name = this._asSymbol(processor.name);
      if (!name) throw new Error(`No name specified for ${kindName} extension`)
      if (!processor.processBlockGiven()) {
        throw new Error(`No block specified to process ${kindName} extension`)
      }
      processorInstance = processor;
    } else {
      const [processorArg, nameArg, config] = this._resolveArgs(args, 3);
      if (typeof processorArg === 'function') {
        // Style 2: class constructor
        if (!(processorArg.prototype instanceof kindClass)) {
          throw new Error(
            `Class specified for ${kindName} extension does not inherit from ${kindClass.name}: ${processorArg}`
          )
        }
        processorInstance = new processorArg(this._asSymbol(nameArg), config);
        name = this._asSymbol(processorInstance.name);
        if (!name) throw new Error(`No name specified for ${kindName} extension: ${processorArg}`)
      } else if (processorArg instanceof kindClass) {
        // Style 3: already an instance
        processorArg.updateConfig(config);
        name = nameArg
          ? (processorArg.name = this._asSymbol(nameArg))
          : this._asSymbol(processorArg.name);
        if (!name) throw new Error(`No name specified for ${kindName} extension: ${processorArg}`)
        processorInstance = processorArg;
      } else {
        throw new Error(`Invalid arguments specified for registering ${kindName} extension: ${args}`)
      }
    }

    store[name] = new ProcessorExtension(kind, processorInstance);
    return store[name]
  }

  _reset () {
    this._preprocessor_extensions      = null;
    this._tree_processor_extensions    = null;
    this._postprocessor_extensions     = null;
    this._include_processor_extensions = null;
    this._docinfo_processor_extensions = null;
    this._block_extensions             = null;
    this._block_macro_extensions       = null;
    this._inline_macro_extensions      = null;
    this.document                      = null;
  }

  // Internal: Normalise an args array to the expected number of values.
  //
  // Pops a trailing plain-object as options (or uses {}), then pads / trims
  // the remaining args to (expect - 1) elements, then appends the options object.
  // If expect === 1, returns just the options object.
  _resolveArgs (args, expect) {
    const last = args[args.length - 1];
    const opts = (
      args.length > 0
      && last !== null
      && typeof last === 'object'
      && !Array.isArray(last)
      && !(last instanceof Processor)
    ) ? args.pop() : {};

    if (expect === 1) return opts

    const missing = expect - 1 - args.length;
    if (missing > 0) {
      for (let i = 0; i < missing; i++) args.push(undefined);
    } else if (missing < 0) {
      args.splice(args.length + missing, -missing);
    }
    args.push(opts);
    return args
  }

  _asSymbol (name) {
    return name != null ? String(name) : null
  }
}

// ── Extensions module namespace ───────────────────────────────────────────────

// Module-level state (mirrors Ruby module instance variables @auto_id / @groups).
let _autoId = -1;
const _groups = Object.create(null);

// Public: The primary entry point for registering extensions globally.
//
// Mirrors the class-level methods on the Ruby Asciidoctor::Extensions module.
const Extensions = {
  // Internal: Generate a unique name for an anonymous extension group.
  generateName () {
    return `extgrp${this.nextAutoId()}`
  },

  nextAutoId () {
    return ++_autoId
  },

  // Public: Returns the plain Object that maps names to registered groups.
  groups () {
    return _groups
  },

  // Public: Creates a new Registry, optionally pre-populated with a named block.
  //
  // name  - Optional String name for the group (default: auto-generated).
  // block - Optional Function to register as the group.
  //
  // Returns a Registry.
  create (name = null, block = null) {
    if (block) {
      return new Registry({ [name || this.generateName()]: block })
    }
    return new Registry()
  },

  // Public: Registers an extension Group that subsequently registers extensions.
  //
  // name  - Optional String or Symbol name under which to register (default: auto-generated).
  // group - A Function (proc-style), a class constructor with an activate() method,
  //         or an instance with an activate() method.
  //
  // Examples
  //
  //   Extensions.register(UmlExtensions)
  //   Extensions.register('uml', UmlExtensions)
  //   Extensions.register(function () { this.blockMacro('plantuml', PlantUmlBlock) })
  //   Extensions.register('uml', function () { this.blockMacro('plantuml', PlantUmlBlock) })
  //
  // Returns the registered group.
  register (...args) {
    const argc = args.length;
    if (argc === 0) throw new Error('Extension group to register not specified')
    const group = args.pop();
    if (!group) throw new Error('Extension group to register not specified')
    const name = args.pop() ?? this.generateName();
    if (args.length > 0) throw new Error(`Wrong number of arguments (${argc} for 1..2)`)
    _groups[String(name)] = group;
    return group
  },

  // Public: Unregister all statically-registered extension groups.
  unregisterAll () {
    for (const key of Object.keys(_groups)) delete _groups[key];
  },

  // Public: Unregister statically-registered extension groups by name.
  //
  // names - One or more String or Symbol group names to unregister.
  unregister (...names) {
    for (const name of names) delete _groups[String(name)];
  },

  // ── Processor factory helpers (mirrors core API) ─────────────────────────────
  //
  // Each pair: create<Kind>(name?, functions) → class constructor
  //            new<Kind>(name?, functions)    → instance of that class
  //
  // The `name` argument is optional; if omitted the sole argument is `functions`.

  _buildProcessorClass (BaseClass, name, functions) {
    if (arguments.length === 2) { functions = name; name = null; }
    const klass = class extends BaseClass {};
    if (name) Object.defineProperty(klass, 'name', { value: name });
    Object.assign(klass.prototype, functions);
    return klass
  },

  createPreprocessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(Preprocessor, name, functions)
  },
  newPreprocessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createPreprocessor(name, functions))()
  },

  createTreeProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(TreeProcessor, name, functions)
  },
  newTreeProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createTreeProcessor(name, functions))()
  },

  createPostprocessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(Postprocessor, name, functions)
  },
  newPostprocessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createPostprocessor(name, functions))()
  },

  createIncludeProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(IncludeProcessor, name, functions)
  },
  newIncludeProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createIncludeProcessor(name, functions))()
  },

  createDocinfoProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(DocinfoProcessor, name, functions)
  },
  newDocinfoProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createDocinfoProcessor(name, functions))()
  },

  createBlockProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(BlockProcessor, name, functions)
  },
  newBlockProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createBlockProcessor(name, functions))()
  },

  createInlineMacroProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(InlineMacroProcessor, name, functions)
  },
  newInlineMacroProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createInlineMacroProcessor(name, functions))()
  },

  createBlockMacroProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return this._buildProcessorClass(BlockMacroProcessor, name, functions)
  },
  newBlockMacroProcessor (name, functions) {
    if (arguments.length === 1) { functions = name; name = null; }
    return new (this.createBlockMacroProcessor(name, functions))()
  },
};

const extensions = /*#__PURE__*/Object.freeze({
  __proto__: null,
  BlockMacroProcessor: BlockMacroProcessor,
  BlockProcessor: BlockProcessor,
  BlockProcessorDsl: BlockProcessorDsl,
  DocinfoProcessor: DocinfoProcessor,
  DocinfoProcessorDsl: DocinfoProcessorDsl,
  DocumentProcessorDsl: DocumentProcessorDsl,
  Extension: Extension,
  Extensions: Extensions,
  Group: Group,
  IncludeProcessor: IncludeProcessor,
  IncludeProcessorDsl: IncludeProcessorDsl,
  InlineMacroProcessor: InlineMacroProcessor,
  InlineMacroProcessorDsl: InlineMacroProcessorDsl,
  MacroProcessor: MacroProcessor,
  MacroProcessorDsl: MacroProcessorDsl,
  Postprocessor: Postprocessor,
  Preprocessor: Preprocessor,
  Processor: Processor,
  ProcessorDsl: ProcessorDsl,
  ProcessorExtension: ProcessorExtension,
  Registry: Registry,
  SyntaxProcessorDsl: SyntaxProcessorDsl,
  TreeProcessor: TreeProcessor,
  Treeprocessor: Treeprocessor
});

// ESM port of converter/html5.rb
//
// Ruby-to-JavaScript notes:
//   - @xml_mode / @void_element_slash → this._xmlMode / this._voidSlash
//   - Ruby symbol keys in QUOTE_TAGS → plain string keys
//   - node.attr?  → node.hasAttr()
//   - node.option? → node.hasOption()
//   - node.title? → node.hasTitle()
//   - node.sections? → node.hasSections()
//   - node.blocks? → node.hasBlocks()
//   - node.footnotes? → node.hasFootnotes()
//   - node.noheader/notitle/nofooter → node.isNoheader()/isNotitle()/isNofooter()
//   - node.sections → node.sections() (method)
//   - await node.content() → await node.content() (method on Block/Document)
//   - alias convert_pass content_only → convert_pass delegates to this.contentOnly()
//   - Stylesheets.instance.primary_stylesheet_data → not yet ported; embed yields empty <style>
//   - read_svg_contents uses readContents (supports local and remote URIs via allow-uri-read)


// ── Local regex constants ─────────────────────────────────────────────────────

const DropAnchorRx     = /<(?:a\b[^>]*|\/a)>/g;
const LeadingAnchorsRx = /^(?:<a id="[^"]+"><\/a>)+/;
const StemBreakRx      = / *\\\n(?:\\?\n)*|\n\n+/g;
// NOTE In JavaScript ^ matches start of string when the m flag is not set (same as Opal)
const SvgPreambleRx    = /^[\s\S]*?(?=<svg[\s>])/;
const SvgStartTagRx    = /^<svg(?:\s[^>]*)?>/;
const DimensionAttributeRx = /\s(?:width|height|style)=(["'])[\s\S]*?\1/g;

// ── Quote tag table ───────────────────────────────────────────────────────────

const QUOTE_TAGS$1 = {
  monospaced:  ['<code>', '</code>', true],
  emphasis:    ['<em>', '</em>', true],
  strong:      ['<strong>', '</strong>', true],
  double:      ['&#8220;', '&#8221;'],
  single:      ['&#8216;', '&#8217;'],
  mark:        ['<mark>', '</mark>', true],
  superscript: ['<sup>', '</sup>', true],
  subscript:   ['<sub>', '</sub>', true],
  asciimath:   ['\\$', '\\$'],
  latexmath:   ['\\(', '\\)'],
};
const DEFAULT_QUOTE_TAG = ['', ''];

// ── Html5Converter ────────────────────────────────────────────────────────────

class Html5Converter extends ConverterBase {
  // Public: Create a new Html5Converter instance.
  static create (backend = 'html5', opts = {}) {
    return new this(backend, opts)
  }

  constructor (backend, opts = {}) {
    super(backend, opts);
    let syntax;
    if (opts.htmlsyntax === 'xml') {
      syntax = 'xml';
      this._xmlMode = true;
      this._voidSlash = '/';
    } else {
      syntax = 'html';
      this._xmlMode = false;
      this._voidSlash = '';
    }
    this.initBackendTraits({
      basebackend: 'html',
      filetype: 'html',
      htmlsyntax: syntax,
      outfilesuffix: '.html',
      supportsTemplates: true,
    });
  }

  async convert_document (node) {
    const slash = this._voidSlash;
    const br = `<br${slash}>`;
    let assetUriScheme = node.attr('asset-uri-scheme', 'https');
    if (assetUriScheme) assetUriScheme = `${assetUriScheme}:`;
    const cdnBaseUrl = `${assetUriScheme}//cdnjs.cloudflare.com/ajax/libs`;
    const linkcss = node.hasAttr('linkcss');
    const maxWidthAttr = node.hasAttr('max-width') ? ` style="max-width: ${node.attr('max-width')};"` : '';
    const result = ['<!DOCTYPE html>'];
    const langAttribute = node.hasAttr('nolang') ? '' : ` lang="${node.attr('lang', 'en')}"`;
    result.push(`<html${this._xmlMode ? ' xmlns="http://www.w3.org/1999/xhtml"' : ''}${langAttribute}>`);
    result.push(`<head>
<meta charset="${node.attr('encoding', 'UTF-8')}"${slash}>
<meta http-equiv="X-UA-Compatible" content="IE=edge"${slash}>
<meta name="viewport" content="width=device-width, initial-scale=1.0"${slash}>`);
    let reproducible;
    if (!(reproducible = node.hasAttr('reproducible'))) {
      result.push(`<meta name="generator" content="Asciidoctor ${node.attr('asciidoctor-version')}"${slash}>`);
    }
    if (node.hasAttr('app-name')) {
      result.push(`<meta name="application-name" content="${node.attr('app-name')}"${slash}>`);
    }
    if (node.hasAttr('description')) {
      result.push(`<meta name="description" content="${node.attr('description')}"${slash}>`);
    }
    if (node.hasAttr('keywords')) {
      result.push(`<meta name="keywords" content="${node.attr('keywords')}"${slash}>`);
    }
    if (node.hasAttr('authors')) {
      let authors = node.subReplacements(node.attr('authors'));
      if (authors.includes('<')) authors = authors.replace(XmlSanitizeRx, '');
      result.push(`<meta name="author" content="${authors}"${slash}>`);
    }
    if (node.hasAttr('copyright')) {
      result.push(`<meta name="copyright" content="${node.attr('copyright')}"${slash}>`);
    }
    if (node.hasAttr('favicon')) {
      // Access raw attribute value to detect empty string (set without value)
      let iconHref = 'favicon' in node.attributes ? node.attributes['favicon'] : '';
      let iconType;
      if (!iconHref) {
        iconHref = 'favicon.ico';
        iconType = 'image/x-icon';
      } else {
        const iconExt = extname(iconHref, null);
        if (iconExt) {
          iconType = iconExt === '.ico' ? 'image/x-icon' : `image/${iconExt.slice(1)}`;
        } else {
          iconType = 'image/x-icon';
        }
      }
      result.push(`<link rel="icon" type="${iconType}" href="${iconHref}"${slash}>`);
    }
    result.push(`<title>${node.doctitle({ sanitize: true, use_fallback: true })}</title>`);

    // Access raw attribute value; '' means "use default stylesheet"
    const stylesheetRawVal = 'stylesheet' in node.attributes ? node.attributes['stylesheet'] : null;
    if (DEFAULT_STYLESHEET_KEYS.has(stylesheetRawVal)) {
      if (node.hasAttr('webfonts')) {
        const webfonts = node.attributes['webfonts'] ?? '';
        const fontFamily = webfonts ||
          'Open+Sans:300,300italic,400,400italic,600,600italic%7CNoto+Serif:400,400italic,700,700italic%7CNoto+Sans+Mono:400,700';
        result.push(`<link rel="stylesheet" href="${assetUriScheme}//fonts.googleapis.com/css?family=${fontFamily}"${slash}>`);
      }
      if (linkcss) {
        result.push(`<link rel="stylesheet" href="${node.normalizeWebPath(DEFAULT_STYLESHEET_NAME, node.attr('stylesdir'), false)}"${slash}>`);
      } else {
        // NOTE Stylesheets.instance.primary_stylesheet_data is not yet ported to JS
        result.push('<style>\n</style>');
      }
    } else if (node.hasAttr('stylesheet')) {
      if (linkcss) {
        result.push(`<link rel="stylesheet" href="${node.normalizeWebPath(node.attr('stylesheet'), node.attr('stylesdir'))}"${slash}>`);
      } else {
        const cssPath = node.normalizeSystemPath(node.attr('stylesheet'), node.attr('stylesdir'));
        const cssData = await node.readAsset(cssPath, { warnOnFailure: true, label: 'stylesheet' }) ?? '';
        result.push(`<style>\n${cssData}\n</style>`);
      }
    }

    if (node.hasAttr('icons', 'font')) {
      if (node.hasAttr('iconfont-remote')) {
        const cdnUrl = node.attr('iconfont-cdn') ??
          `${cdnBaseUrl}/font-awesome/${FONT_AWESOME_VERSION}/css/font-awesome.min.css`;
        result.push(`<link rel="stylesheet" href="${cdnUrl}"${slash}>`);
      } else {
        const iconfontStylesheet = `${node.attr('iconfont-name', 'font-awesome')}.css`;
        result.push(`<link rel="stylesheet" href="${node.normalizeWebPath(iconfontStylesheet, node.attr('stylesdir'), false)}"${slash}>`);
      }
    }

    const syntaxHl = node.syntaxHighlighter;
    let syntaxHlDocinfoHeadIdx;
    if (syntaxHl) {
      syntaxHlDocinfoHeadIdx = result.length;
      result.push(''); // placeholder; replaced or spliced out below
    }

    const docinfoContent = await node.docinfo();
    if (docinfoContent) result.push(docinfoContent);

    result.push('</head>');

    const idAttr = node.id ? ` id="${node.id}"` : '';
    const sectioned = node.hasSections();
    let classes;
    if (sectioned && node.hasAttr('toc-class') && node.hasAttr('toc') && node.hasAttr('toc-placement', 'auto')) {
      classes = [node.doctype, node.attr('toc-class'), `toc-${node.attr('toc-position', 'header')}`];
    } else {
      classes = [node.doctype];
    }
    if (node.role) classes.push(node.role);
    result.push(`<body${idAttr} class="${classes.join(' ')}">`);

    const headerDocinfo = await node.docinfo('header');
    if (headerDocinfo) result.push(headerDocinfo);

    if (!node.isNoheader()) {
      result.push(`<div id="header"${maxWidthAttr}>`);
      if (node.doctype === 'manpage') {
        result.push(`<h1>${node.doctitle()} Manual Page</h1>`);
        if (sectioned && node.hasAttr('toc') && node.hasAttr('toc-placement', 'auto')) {
          result.push(`<div id="toc" class="${node.attr('toc-class', 'toc')}">
<div id="toctitle">${node.attr('toc-title')}</div>
${await node.converter.convert(node, 'outline')}
</div>`);
        }
        if (node.hasAttr('manpurpose')) result.push(this._generateMannameSection(node));
      } else {
        if (node.hasHeader()) {
          if (!node.isNotitle()) result.push(`<h1>${node.header.title}</h1>`);
          const details = [];
          let idx = 1;
          for (const author of node.authors()) {
            details.push(`<span id="author${idx > 1 ? idx : ''}" class="author">${node.subReplacements(author.name)}</span>${br}`);
            if (author.email) {
              details.push(`<span id="email${idx > 1 ? idx : ''}" class="email">${await node.subMacros(author.email)}</span>${br}`);
            }
            idx++;
          }
          if (node.hasAttr('revnumber')) {
            const versionLabel = (node.attr('version-label') || '').toLowerCase();
            details.push(`<span id="revnumber">${versionLabel} ${node.attr('revnumber')}${node.hasAttr('revdate') ? ',' : ''}</span>`);
          }
          if (node.hasAttr('revdate')) {
            details.push(`<span id="revdate">${node.attr('revdate')}</span>`);
          }
          if (node.hasAttr('revremark')) {
            details.push(`${br}<span id="revremark">${node.attr('revremark')}</span>`);
          }
          if (details.length > 0) {
            result.push('<div class="details">');
            result.push(...details);
            result.push('</div>');
          }
        }
        if (sectioned && node.hasAttr('toc') && node.hasAttr('toc-placement', 'auto')) {
          result.push(`<div id="toc" class="${node.attr('toc-class', 'toc')}">
<div id="toctitle">${node.attr('toc-title')}</div>
${await node.converter.convert(node, 'outline')}
</div>`);
        }
      }
      result.push('</div>');
    }

    result.push(`<div id="content"${maxWidthAttr}>
${await node.content()}
</div>`);

    if (node.hasFootnotes() && !node.hasAttr('nofootnotes')) {
      result.push(`<div id="footnotes"${maxWidthAttr}>
<hr${slash}>`);
      for (const footnote of node.footnotes) {
        result.push(`<div class="footnote" id="_footnotedef_${footnote.index}">
<a href="#_footnoteref_${footnote.index}">${footnote.index}</a>. ${footnote.text}
</div>`);
      }
      result.push('</div>');
    }

    if (!node.isNofooter()) {
      result.push(`<div id="footer"${maxWidthAttr}>`);
      result.push('<div id="footer-text">');
      if (node.hasAttr('revnumber')) {
        result.push(`${node.attr('version-label')} ${node.attr('revnumber')}${br}`);
      }
      if (node.hasAttr('last-update-label') && !reproducible) {
        result.push(`${node.attr('last-update-label')} ${node.attr('docdatetime')}`);
      }
      result.push('</div>');
      result.push('</div>');
    }

    // JavaScript (and auxiliary stylesheets) loaded at end of body for performance
    if (syntaxHl) {
      if (syntaxHl.hasDocinfo('head')) {
        result[syntaxHlDocinfoHeadIdx] = syntaxHl.docinfo('head', node, {
          cdn_base_url: cdnBaseUrl,
          linkcss,
          self_closing_tag_slash: slash,
        });
      } else {
        result.splice(syntaxHlDocinfoHeadIdx, 1);
      }
      if (syntaxHl.hasDocinfo('footer')) {
        result.push(syntaxHl.docinfo('footer', node, {
          cdn_base_url: cdnBaseUrl,
          linkcss,
          self_closing_tag_slash: slash,
        }));
      }
    }

    if (node.hasAttr('stem')) {
      let eqnumsVal = node.attr('eqnums', 'none');
      if (!eqnumsVal) eqnumsVal = 'AMS';
      const eqnumsOpt = ` equationNumbers: { autoNumber: "${eqnumsVal}" } `;
      // IMPORTANT inspect calls on delimiter arrays are intentional for JavaScript compat (emulates JSON.stringify)
      result.push(`<script type="text/x-mathjax-config">
MathJax.Hub.Config({
  messageStyle: "none",
  tex2jax: {
    inlineMath: [${JSON.stringify(INLINE_MATH_DELIMITERS.latexmath)}],
    displayMath: [${JSON.stringify(BLOCK_MATH_DELIMITERS.latexmath)}],
    ignoreClass: "nostem|nolatexmath"
  },
  asciimath2jax: {
    delimiters: [${JSON.stringify(BLOCK_MATH_DELIMITERS.asciimath)}],
    ignoreClass: "nostem|noasciimath"
  },
  TeX: {${eqnumsOpt}}
})
MathJax.Hub.Register.StartupHook("AsciiMath Jax Ready", function () {
  MathJax.InputJax.AsciiMath.postfilterHooks.Add(function (data, node) {
    if ((node = data.script.parentNode) && (node = node.parentNode) && node.classList.contains("stemblock")) {
      data.math.root.display = "block"
    }
    return data
  })
})
</script>
<script src="${cdnBaseUrl}/mathjax/${MATHJAX_VERSION}/MathJax.js?config=TeX-MML-AM_CHTML"></script>`);
    }

    const footerDocinfo = await node.docinfo('footer');
    if (footerDocinfo) result.push(footerDocinfo);

    result.push('</body>');
    result.push('</html>');
    return result.join(LF$1)
  }

  async convert_embedded (node) {
    const result = [];
    if (node.doctype === 'manpage') {
      if (!node.isNotitle()) {
        const idAttr = node.id ? ` id="${node.id}"` : '';
        result.push(`<h1${idAttr}>${node.doctitle()} Manual Page</h1>`);
      }
      if (node.hasAttr('manpurpose')) result.push(this._generateMannameSection(node));
    } else if (node.hasHeader() && !node.isNotitle()) {
      const idAttr = node.id ? ` id="${node.id}"` : '';
      result.push(`<h1${idAttr}>${node.header.title}</h1>`);
    }

    if (node.hasSections() && node.hasAttr('toc')) {
      const tocP = node.attr('toc-placement');
      if (tocP !== 'macro' && tocP !== 'preamble') {
        result.push(`<div id="toc" class="toc">
<div id="toctitle">${node.attr('toc-title')}</div>
${await node.converter.convert(node, 'outline')}
</div>`);
      }
    }

    result.push(await node.content());

    if (node.hasFootnotes() && !node.hasAttr('nofootnotes')) {
      result.push(`<div id="footnotes">
<hr${this._voidSlash}>`);
      for (const footnote of node.footnotes) {
        result.push(`<div class="footnote" id="_footnotedef_${footnote.index}">
<a href="#_footnoteref_${footnote.index}">${footnote.index}</a>. ${footnote.text}
</div>`);
      }
      result.push('</div>');
    }

    return result.join(LF$1)
  }

  async convert_outline (node, opts = {}) {
    if (!node.hasSections()) return null
    const sections = node.sections();
    const parts = node.context === 'document' && node.isMultipart();
    const sectlevel = parts ? 0 : sections[0].level;
    const sectnumlevels = opts.sectnumlevels ??
      parseInt(node.document.attributes['sectnumlevels'] || 3, 10);

    let toclevels = opts.toclevels ?? null;
    if (toclevels == null) {
      const toclevelAttr = node.document.attributes['toclevels'];
      if (toclevelAttr) {
        toclevels = parseInt(toclevelAttr, 10);
        if (toclevels < 1 && !parts) toclevels = 1;
      } else {
        toclevels = 2;
      }
    }

    const result = [`<ul class="sectlevel${sectlevel}">`];
    for (const section of sections) {
      const slevel = section.level;
      const stoclevels = section.hasAttr('toclevels')
        ? parseInt(section.attr('toclevels'), 10)
        : toclevels;
      if (slevel > stoclevels) continue

      let stitle;
      if (section.caption) {
        stitle = section.captionedTitle();
      } else if (section.numbered && slevel <= sectnumlevels) {
        if (slevel < 2 && node.document.doctype === 'book') {
          const sectname = section.sectname;
          if (sectname === 'chapter') {
            const signifier = node.document.attributes['chapter-signifier'];
            stitle = `${signifier ? `${signifier} ` : ''}${section.sectnum()} ${section.title}`;
          } else if (sectname === 'part') {
            const signifier = node.document.attributes['part-signifier'];
            stitle = `${signifier ? `${signifier} ` : ''}${section.sectnum(null, ':')} ${section.title}`;
          } else {
            stitle = `${section.sectnum()} ${section.title}`;
          }
        } else {
          stitle = `${section.sectnum()} ${section.title}`;
        }
      } else {
        stitle = section.title;
      }

      if (stitle && stitle.includes('<a')) {
        stitle = stitle.replace(new RegExp(DropAnchorRx.source, 'g'), '');
      }

      const otag = slevel === sectlevel ? '<li>' : `<li class="sectlevel${slevel}">`;
      if (slevel < stoclevels) {
        const childTocLevel = await this.convert_outline(section, { toclevels: stoclevels, sectnumlevels });
        if (childTocLevel) {
          result.push(`${otag}<a href="#${section.id}">${stitle}</a>`);
          result.push(childTocLevel);
          result.push('</li>');
          continue
        }
      }
      result.push(`${otag}<a href="#${section.id}">${stitle}</a></li>`);
    }
    result.push('</ul>');
    return result.join(LF$1)
  }

  async convert_section (node) {
    const docAttrs = node.document.attributes;
    const level = node.level;
    let title;
    if (node.caption) {
      title = node.captionedTitle();
    } else if (node.numbered && level <= parseInt(docAttrs['sectnumlevels'] || 3, 10)) {
      if (level < 2 && node.document.doctype === 'book') {
        const sectname = node.sectname;
        if (sectname === 'chapter') {
          const signifier = docAttrs['chapter-signifier'];
          title = `${signifier ? `${signifier} ` : ''}${node.sectnum()} ${node.title}`;
        } else if (sectname === 'part') {
          const signifier = docAttrs['part-signifier'];
          title = `${signifier ? `${signifier} ` : ''}${node.sectnum(null, ':')} ${node.title}`;
        } else {
          title = `${node.sectnum()} ${node.title}`;
        }
      } else {
        title = `${node.sectnum()} ${node.title}`;
      }
    } else {
      title = node.title;
    }

    let idAttr = '';
    if (node.id) {
      const id = node.id;
      idAttr = ` id="${id}"`;
      if ('sectlinks' in docAttrs) {
        let m;
        if (title.startsWith('<a ') && (m = title.match(LeadingAnchorsRx))) {
          title = `${m[0]}<a class="link" href="#${id}">${title.slice(m[0].length)}</a>`;
        } else {
          title = `<a class="link" href="#${id}">${title}</a>`;
        }
      }
      if ('sectanchors' in docAttrs) {
        if (docAttrs['sectanchors'] === 'after') {
          title = `${title}<a class="anchor" href="#${id}"></a>`;
        } else {
          title = `<a class="anchor" href="#${id}"></a>${title}`;
        }
      }
    }

    const role = node.role;
    if (level === 0) {
      return `<h1${idAttr} class="sect0${role ? ` ${role}` : ''}">${title}</h1>
${await node.content()}`
    }
    return `<div class="sect${level}${role ? ` ${role}` : ''}">
<h${level + 1}${idAttr}>${title}</h${level + 1}>
${level === 1
      ? `<div class="sectionbody">
${await node.content()}
</div>`
      : await node.content()}
</div>`
  }

  async convert_admonition (node) {
    const idAttr = node.id ? ` id="${node.id}"` : '';
    const name = node.attr('name');
    const titleElement = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
    let label;
    if (node.document.hasAttr('icons')) {
      if (node.document.hasAttr('icons', 'font') && !node.hasAttr('icon')) {
        label = `<i class="fa icon-${name}" title="${node.attr('textlabel')}"></i>`;
      } else {
        label = `<img src="${await node.iconUri(name)}" alt="${node.attr('textlabel')}"${this._voidSlash}>`;
      }
    } else {
      label = `<div class="title">${node.attr('textlabel')}</div>`;
    }
    return `<div${idAttr} class="admonitionblock ${name}${node.role ? ` ${node.role}` : ''}">
<table>
<tr>
<td class="icon">
${label}
</td>
<td class="content">
${titleElement}${await node.content()}
</td>
</tr>
</table>
</div>`
  }

  async convert_audio (node) {
    const xml = this._xmlMode;
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = ['audioblock', node.role].filter(Boolean);
    const classAttribute = ` class="${classes.join(' ')}"`;
    const titleElement = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
    const startT = node.attr('start');
    const endT = node.attr('end');
    const timeAnchor = (startT || endT) ? `#t=${startT || ''}${endT ? `,${endT}` : ''}` : '';
    return `<div${idAttribute}${classAttribute}>
${titleElement}<div class="content">
<audio src="${node.mediaUri(node.attr('target'))}${timeAnchor}"${node.hasOption('autoplay') ? this._appendBooleanAttr('autoplay', xml) : ''}${node.hasOption('nocontrols') ? '' : this._appendBooleanAttr('controls', xml)}${node.hasOption('loop') ? this._appendBooleanAttr('loop', xml) : ''}>
Your browser does not support the audio tag.
</audio>
</div>
</div>`
  }

  async convert_colist (node) {
    const result = [];
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = ['colist', node.style, node.role].filter(Boolean);
    const classAttribute = ` class="${classes.join(' ')}"`;

    result.push(`<div${idAttribute}${classAttribute}>`);
    if (node.hasTitle()) result.push(`<div class="title">${node.title}</div>`);

    if (node.document.hasAttr('icons')) {
      result.push('<table>');
      const fontIcons = node.document.hasAttr('icons', 'font');
      let num = 0;
      for (const item of node.items) {
        num++;
        let numLabel;
        if (fontIcons) {
          numLabel = `<i class="conum" data-value="${num}"></i><b>${num}</b>`;
        } else {
          numLabel = `<img src="${await node.iconUri(`callouts/${num}`)}" alt="${num}"${this._voidSlash}>`;
        }
        result.push(`<tr>
<td>${numLabel}</td>
<td>${item.text}${item.hasBlocks() ? LF$1 + await item.content() : ''}</td>
</tr>`);
      }
      result.push('</table>');
    } else {
      result.push('<ol>');
      for (const item of node.items) {
        result.push(`<li>
<p>${item.text}</p>${item.hasBlocks() ? LF$1 + await item.content() : ''}
</li>`);
      }
      result.push('</ol>');
    }

    result.push('</div>');
    return result.join(LF$1)
  }

  async convert_dlist (node) {
    const result = [];
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    let classes;
    switch (node.style) {
      case 'qanda':
        classes = ['qlist', 'qanda', node.role];
        break
      case 'horizontal':
        classes = ['hdlist', node.role];
        break
      default:
        classes = ['dlist', node.style, node.role];
    }
    const classAttribute = ` class="${classes.filter(Boolean).join(' ')}"`;

    result.push(`<div${idAttribute}${classAttribute}>`);
    if (node.hasTitle()) result.push(`<div class="title">${node.title}</div>`);

    switch (node.style) {
      case 'qanda':
        result.push('<ol>');
        for (const [terms, dd] of node.items) {
          result.push('<li>');
          for (const dt of terms) {
            result.push(`<p><em>${dt.text}</em></p>`);
          }
          if (dd) {
            if (dd.hasText()) result.push(`<p>${dd.text}</p>`);
            if (dd.hasBlocks()) result.push(await dd.content());
          }
          result.push('</li>');
        }
        result.push('</ol>');
        break
      case 'horizontal': {
        const slash = this._voidSlash;
        result.push('<table>');
        if (node.hasAttr('labelwidth') || node.hasAttr('itemwidth')) {
          result.push('<colgroup>');
          const labelWidthAttr = node.hasAttr('labelwidth')
            ? ` width="${node.attr('labelwidth').replace(/%$/, '')}%"`
            : '';
          result.push(`<col${labelWidthAttr}${slash}>`);
          const itemWidthAttr = node.hasAttr('itemwidth')
            ? ` width="${node.attr('itemwidth').replace(/%$/, '')}%"`
            : '';
          result.push(`<col${itemWidthAttr}${slash}>`);
          result.push('</colgroup>');
        }
        for (const [terms, dd] of node.items) {
          result.push('<tr>');
          result.push(`<td class="hdlist1${node.hasOption('strong') ? ' strong' : ''}">`);
          let firstTerm = true;
          for (const dt of terms) {
            if (!firstTerm) result.push(`<br${slash}>`);
            result.push(dt.text);
            firstTerm = false;
          }
          result.push('</td>');
          result.push('<td class="hdlist2">');
          if (dd) {
            if (dd.hasText()) result.push(`<p>${dd.text}</p>`);
            if (dd.hasBlocks()) result.push(await dd.content());
          }
          result.push('</td>');
          result.push('</tr>');
        }
        result.push('</table>');
        break
      }
      default: {
        result.push('<dl>');
        const dtStyleAttribute = node.style ? '' : ' class="hdlist1"';
        for (const [terms, dd] of node.items) {
          for (const dt of terms) {
            result.push(`<dt${dtStyleAttribute}>${dt.text}</dt>`);
          }
          if (!dd) continue
          result.push('<dd>');
          if (dd.hasText()) result.push(`<p>${dd.text}</p>`);
          if (dd.hasBlocks()) result.push(await dd.content());
          result.push('</dd>');
        }
        result.push('</dl>');
      }
    }

    result.push('</div>');
    return result.join(LF$1)
  }

  async convert_example (node) {
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    if (node.hasOption('collapsible')) {
      const classAttribute = node.role ? ` class="${node.role}"` : '';
      const summaryElement = node.hasTitle()
        ? `<summary class="title">${node.title}</summary>`
        : '<summary class="title">Details</summary>';
      return `<details${idAttribute}${classAttribute}${node.hasOption('open') ? ' open' : ''}>
${summaryElement}
<div class="content">
${await node.content()}
</div>
</details>`
    }
    const titleElement = node.hasTitle() ? `<div class="title">${node.captionedTitle()}</div>\n` : '';
    const role = node.role;
    return `<div${idAttribute} class="exampleblock${role ? ` ${role}` : ''}">
${titleElement}<div class="content">
${await node.content()}
</div>
</div>`
  }

  async convert_floating_title (node) {
    const tagName = `h${node.level + 1}`;
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = [node.style, node.role].filter(Boolean);
    return `<${tagName}${idAttribute} class="${classes.join(' ')}">${node.title}</${tagName}>`
  }

  async convert_image (node) {
    const target = node.attr('target');
    const widthAttr = node.hasAttr('width') ? ` width="${node.attr('width')}"` : '';
    const heightAttr = node.hasAttr('height') ? ` height="${node.attr('height')}"` : '';
    const slash = this._voidSlash;
    let img, src;
    if ((node.hasAttr('format', 'svg') || target.includes('.svg')) &&
      node.document.safe < SafeMode.SECURE) {
      if (node.hasOption('inline')) {
        img = await this.readSvgContents(node, target) || `<span class="alt">${node.alt()}</span>`;
      } else if (node.hasOption('interactive') && node.document.safe >= SafeMode.SERVER) {
        const fallback = node.hasAttr('fallback')
          ? `<img src="${await node.imageUri(node.attr('fallback'))}" alt="${this._encodeAttrValue(node.alt())}"${widthAttr}${heightAttr}${slash}>`
          : `<span class="alt">${node.alt()}</span>`;
        src = await node.imageUri(target);
        img = `<object type="image/svg+xml" data="${src}"${widthAttr}${heightAttr}>${fallback}</object>`;
      } else {
        src = await node.imageUri(target);
        img = `<img src="${src}" alt="${this._encodeAttrValue(node.alt())}"${widthAttr}${heightAttr}${slash}>`;
      }
    } else {
      src = await node.imageUri(target);
      img = `<img src="${src}" alt="${this._encodeAttrValue(node.alt())}"${widthAttr}${heightAttr}${slash}>`;
    }

    if (node.hasAttr('link')) {
      let hrefAttrVal = node.attr('link');
      if (hrefAttrVal === 'self') hrefAttrVal = src;
      if (hrefAttrVal) {
        img = `<a class="image" href="${hrefAttrVal}"${this._appendLinkConstraintAttrs(node).join('')}>${img}</a>`;
      }
    }

    const idAttr = node.id ? ` id="${node.id}"` : '';
    const classes = ['imageblock'];
    if (node.hasAttr('float')) classes.push(node.attr('float'));
    if (node.hasAttr('align')) classes.push(`text-${node.attr('align')}`);
    if (node.role) classes.push(node.role);
    const classAttr = ` class="${classes.join(' ')}"`;
    const titleEl = node.hasTitle() ? `\n<div class="title">${node.captionedTitle()}</div>` : '';
    return `<div${idAttr}${classAttr}>
<div class="content">
${img}
</div>${titleEl}
</div>`
  }

  async convert_listing (node) {
    const nowrap = node.hasOption('nowrap') || !node.document.hasAttr('prewrap');
    let preOpen, preClose, syntaxHl, lang, opts;
    if (node.style === 'source') {
      lang = node.attr('language');
      syntaxHl = node.document.syntaxHighlighter;
      if (syntaxHl) {
        if (syntaxHl.handlesHighlighting()) {
          const docAttrs = node.document.attributes;
          opts = {
            css_mode: docAttrs[`${syntaxHl.name}-css`] || 'class',
            style: docAttrs[`${syntaxHl.name}-style`],
          };
        } else {
          opts = {};
        }
        opts.nowrap = nowrap;
      } else {
        preOpen = `<pre class="highlight${nowrap ? ' nowrap' : ''}"><code${lang ? ` class="language-${lang}" data-lang="${lang}"` : ''}>`;
        preClose = '</code></pre>';
      }
    } else {
      preOpen = `<pre${nowrap ? ' class="nowrap"' : ''}>`;
      preClose = '</pre>';
    }
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const titleElement = node.hasTitle() ? `<div class="title">${node.captionedTitle()}</div>\n` : '';
    const role = node.role;
    const inner = syntaxHl
      ? await syntaxHl.format(node, lang, opts)
      : `${preOpen}${await node.content()}${preClose}`;
    return `<div${idAttribute} class="listingblock${role ? ` ${role}` : ''}">
${titleElement}<div class="content">
${inner}
</div>
</div>`
  }

  async convert_literal (node) {
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const titleElement = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
    const nowrap = !node.document.hasAttr('prewrap') || node.hasOption('nowrap');
    const role = node.role;
    return `<div${idAttribute} class="literalblock${role ? ` ${role}` : ''}">
${titleElement}<div class="content">
<pre${nowrap ? ' class="nowrap"' : ''}>${await node.content()}</pre>
</div>
</div>`
  }

  async convert_stem (node) {
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const titleElement = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
    const style = node.style;
    const [open, close] = BLOCK_MATH_DELIMITERS[style] ?? ['', ''];
    let equation = await node.content();
    if (equation) {
      if (style === 'asciimath' && equation.includes(LF$1)) {
        const br = `${LF$1}<br${this._voidSlash}>`;
        equation = equation.replace(StemBreakRx, (match) => {
          const newlineCount = (match.match(/\n/g) || []).length;
          return `${close}${br.repeat(newlineCount - 1)}${LF$1}${open}`
        });
      }
      if (!equation.startsWith(open) || !equation.endsWith(close)) {
        equation = `${open}${equation}${close}`;
      }
    } else {
      equation = '';
    }
    const role = node.role;
    return `<div${idAttribute} class="stemblock${role ? ` ${role}` : ''}">
${titleElement}<div class="content">
${equation}
</div>
</div>`
  }

  async convert_olist (node) {
    const result = [];
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = ['olist', node.style, node.role].filter(Boolean);
    const classAttribute = ` class="${classes.join(' ')}"`;

    result.push(`<div${idAttribute}${classAttribute}>`);
    if (node.hasTitle()) result.push(`<div class="title">${node.title}</div>`);

    const keyword = node.listMarkerKeyword();
    const typeAttribute = keyword ? ` type="${keyword}"` : '';
    const startAttribute = node.hasAttr('start') ? ` start="${node.attr('start')}"` : '';
    const reversedAttribute = node.hasOption('reversed') ? this._appendBooleanAttr('reversed', this._xmlMode) : '';
    result.push(`<ol class="${node.style}"${typeAttribute}${startAttribute}${reversedAttribute}>`);

    for (const item of node.items) {
      if (item.id) {
        result.push(`<li id="${item.id}"${item.role ? ` class="${item.role}"` : ''}>`);
      } else if (item.role) {
        result.push(`<li class="${item.role}">`);
      } else {
        result.push('<li>');
      }
      result.push(`<p>${item.text}</p>`);
      if (item.hasBlocks()) result.push(await item.content());
      result.push('</li>');
    }

    result.push('</ol>');
    result.push('</div>');
    return result.join(LF$1)
  }

  async convert_open (node) {
    const style = node.style;
    if (style === 'abstract') {
      if (node.parent === node.document && node.document.doctype === 'book') {
        this.logger.warn('abstract block cannot be used in a document without a doctitle when doctype is book. Excluding block content.');
        return ''
      }
      const idAttr = node.id ? ` id="${node.id}"` : '';
      const titleEl = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
      const role = node.role;
      return `<div${idAttr} class="quoteblock abstract${role ? ` ${role}` : ''}">
${titleEl}<blockquote>
${await node.content()}
</blockquote>
</div>`
    }
    if (style === 'partintro' &&
      (node.level > 0 || node.parent.context !== 'section' || node.document.doctype !== 'book')) {
      this.logger.error('partintro block can only be used when doctype is book and must be a child of a book part. Excluding block content.');
      return ''
    }
    const idAttr = node.id ? ` id="${node.id}"` : '';
    const titleEl = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
    const role = node.role;
    return `<div${idAttr} class="openblock${style && style !== 'open' ? ` ${style}` : ''}${role ? ` ${role}` : ''}">
${titleEl}<div class="content">
${await node.content()}
</div>
</div>`
  }

  async convert_page_break (_node) {
    return '<div class="page-break"></div>'
  }

  async convert_paragraph (node) {
    let attributes;
    if (node.role) {
      attributes = `${node.id ? ` id="${node.id}"` : ''} class="paragraph ${node.role}"`;
    } else if (node.id) {
      attributes = ` id="${node.id}" class="paragraph"`;
    } else {
      attributes = ' class="paragraph"';
    }
    if (node.hasTitle()) {
      return `<div${attributes}>
<div class="title">${node.title}</div>
<p>${await node.content()}</p>
</div>`
    }
    return `<div${attributes}>
<p>${await node.content()}</p>
</div>`
  }

  // alias convert_pass → content_only
  async convert_pass (node) {
    return this.contentOnly(node)
  }

  async convert_preamble (node) {
    let toc = '';
    const doc = node.document;
    if (doc.hasAttr('toc-placement', 'preamble') && doc.hasSections() && doc.hasAttr('toc')) {
      toc = `
<div id="toc" class="${doc.attr('toc-class', 'toc')}">
<div id="toctitle">${doc.attr('toc-title')}</div>
${await doc.converter.convert(doc, 'outline')}
</div>`;
    }
    return `<div id="preamble">
<div class="sectionbody">
${await node.content()}
</div>${toc}
</div>`
  }

  async convert_quote (node) {
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = ['quoteblock', node.role].filter(Boolean);
    const classAttribute = ` class="${classes.join(' ')}"`;
    const titleElement = node.hasTitle() ? `\n<div class="title">${node.title}</div>` : '';
    const attribution = node.hasAttr('attribution') ? node.attr('attribution') : null;
    const citetitle = node.hasAttr('citetitle') ? node.attr('citetitle') : null;
    let attributionElement = '';
    if (attribution || citetitle) {
      const citeElement = citetitle ? `<cite>${citetitle}</cite>` : '';
      const attributionText = attribution
        ? `&#8212; ${attribution}${citetitle ? `<br${this._voidSlash}>\n` : ''}`
        : '';
      attributionElement = `\n<div class="attribution">\n${attributionText}${citeElement}\n</div>`;
    }
    return `<div${idAttribute}${classAttribute}>${titleElement}
<blockquote>
${await node.content()}
</blockquote>${attributionElement}
</div>`
  }

  async convert_thematic_break (node) {
    const classAttribute = node.role ? ` class="${node.role}"` : '';
    return `<hr${classAttribute}${this._voidSlash}>`
  }

  async convert_sidebar (node) {
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const titleElement = node.hasTitle() ? `<div class="title">${node.title}</div>\n` : '';
    const role = node.role;
    return `<div${idAttribute} class="sidebarblock${role ? ` ${role}` : ''}">
<div class="content">
${titleElement}${await node.content()}
</div>
</div>`
  }

  async convert_table (node) {
    const result = [];
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    let frame = node.attr('frame', 'all', 'table-frame');
    if (frame === 'topbot') frame = 'ends';
    const classes = ['tableblock', `frame-${frame}`, `grid-${node.attr('grid', 'all', 'table-grid')}`];
    const stripes = node.attr('stripes', null, 'table-stripes');
    if (stripes) classes.push(`stripes-${stripes}`);
    let widthAttribute = '';
    const autowidth = node.hasOption('autowidth');
    if (autowidth && !node.hasAttr('width')) {
      classes.push('fit-content');
    } else {
      const tablewidth = node.attr('tablepcwidth');
      if (tablewidth == 100) { // eslint-disable-line eqeqeq
        classes.push('stretch');
      } else {
        widthAttribute = ` width="${tablewidth}%"`;
      }
    }
    if (node.hasAttr('float')) classes.push(node.attr('float'));
    if (node.role) classes.push(node.role);
    const classAttribute = ` class="${classes.join(' ')}"`;

    result.push(`<table${idAttribute}${classAttribute}${widthAttribute}>`);
    if (node.hasTitle()) result.push(`<caption class="title">${node.captionedTitle()}</caption>`);

    if (node.attr('rowcount') > 0) {
      const slash = this._voidSlash;
      result.push('<colgroup>');
      if (autowidth) {
        for (let i = 0; i < node.columns.length; i++) result.push(`<col${slash}>`);
      } else {
        for (const col of node.columns) {
          result.push(col.hasOption('autowidth')
            ? `<col${slash}>`
            : `<col width="${col.attr('colpcwidth')}%"${slash}>`);
        }
      }
      result.push('</colgroup>');

      for (const [tsec, rows] of node.rows.bySection()) {
        if (rows.length === 0) continue
        result.push(`<t${tsec}>`);
        for (const row of rows) {
          result.push('<tr>');
          for (const cell of row) {
            let cellContent;
            if (tsec === 'head') {
              cellContent = cell.text;
            } else {
              switch (cell.style) {
                case 'asciidoc':
                  cellContent = `<div class="content">${await cell.content()}</div>`;
                  break
                case 'literal':
                  cellContent = `<div class="literal"><pre>${cell.text}</pre></div>`;
                  break
                default: {
                  const parts = await cell.content();
                  cellContent = parts.length === 0
                    ? ''
                    : `<p class="tableblock">${parts.join('</p>\n<p class="tableblock">')}</p>`;
                }
              }
            }
            const cellTagName = (tsec === 'head' || cell.style === 'header') ? 'th' : 'td';
            const cellClassAttr = ` class="tableblock halign-${cell.attr('halign')} valign-${cell.attr('valign')}"`;
            const cellColspanAttr = cell.colspan ? ` colspan="${cell.colspan}"` : '';
            const cellRowspanAttr = cell.rowspan ? ` rowspan="${cell.rowspan}"` : '';
            // Use the per-cell captured cellbgcolor (set by {set:cellbgcolor:...} in cell text
            // during precomputeText). Fall back to the current document attribute if not captured.
            const cellbgcolor = '_cellbgcolor' in cell ? cell._cellbgcolor : node.document.attributes['cellbgcolor'];
            const cellStyleAttr = cellbgcolor
              ? ` style="background-color: ${cellbgcolor};"`
              : '';
            result.push(`<${cellTagName}${cellClassAttr}${cellColspanAttr}${cellRowspanAttr}${cellStyleAttr}>${cellContent}</${cellTagName}>`);
          }
          result.push('</tr>');
        }
        result.push(`</t${tsec}>`);
      }
    }
    result.push('</table>');
    return result.join(LF$1)
  }

  async convert_toc (node) {
    const doc = node.document;
    if (!doc.hasAttr('toc-placement', 'macro') || !doc.hasSections() || !doc.hasAttr('toc')) {
      return '<!-- toc disabled -->'
    }
    let idAttr, titleIdAttr;
    if (node.id) {
      idAttr = ` id="${node.id}"`;
      titleIdAttr = ` id="${node.id}title"`;
    } else {
      idAttr = ' id="toc"';
      titleIdAttr = ' id="toctitle"';
    }
    const title = node.hasTitle() ? node.title : doc.attr('toc-title');
    const levels = node.hasAttr('levels') ? parseInt(node.attr('levels'), 10) : null;
    const role = node.hasRoleAttr() ? node.role : doc.attr('toc-class', 'toc');
    return `<div${idAttr} class="${role}">
<div${titleIdAttr} class="title">${title}</div>
${await doc.converter.convert(doc, 'outline', levels != null ? { toclevels: levels } : {})}
</div>`
  }

  async convert_ulist (node) {
    const result = [];
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const divClasses = ['ulist', node.style, node.role].filter(Boolean);
    let markerChecked = '';
    let markerUnchecked = '';
    let ulClassAttribute;
    const checklist = node.hasOption('checklist');
    if (checklist) {
      divClasses.splice(1, 0, 'checklist');
      ulClassAttribute = ' class="checklist"';
      if (node.hasOption('interactive')) {
        if (this._xmlMode) {
          markerChecked = '<input type="checkbox" data-item-complete="1" checked="checked"/> ';
          markerUnchecked = '<input type="checkbox" data-item-complete="0"/> ';
        } else {
          markerChecked = '<input type="checkbox" data-item-complete="1" checked> ';
          markerUnchecked = '<input type="checkbox" data-item-complete="0"> ';
        }
      } else if (node.document.hasAttr('icons', 'font')) {
        markerChecked = '<i class="fa fa-check-square-o"></i> ';
        markerUnchecked = '<i class="fa fa-square-o"></i> ';
      } else {
        markerChecked = '&#10003; ';
        markerUnchecked = '&#10063; ';
      }
    } else {
      ulClassAttribute = node.style ? ` class="${node.style}"` : '';
    }
    result.push(`<div${idAttribute} class="${divClasses.join(' ')}">`);
    if (node.hasTitle()) result.push(`<div class="title">${node.title}</div>`);
    result.push(`<ul${ulClassAttribute}>`);

    for (const item of node.items) {
      if (item.id) {
        result.push(`<li id="${item.id}"${item.role ? ` class="${item.role}"` : ''}>`);
      } else if (item.role) {
        result.push(`<li class="${item.role}">`);
      } else {
        result.push('<li>');
      }
      if (checklist && item.hasAttr('checkbox')) {
        result.push(`<p>${item.hasAttr('checked') ? markerChecked : markerUnchecked}${item.text}</p>`);
      } else {
        result.push(`<p>${item.text}</p>`);
      }
      if (item.hasBlocks()) result.push(await item.content());
      result.push('</li>');
    }

    result.push('</ul>');
    result.push('</div>');
    return result.join(LF$1)
  }

  async convert_verse (node) {
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = ['verseblock', node.role].filter(Boolean);
    const classAttribute = ` class="${classes.join(' ')}"`;
    const titleElement = node.hasTitle() ? `\n<div class="title">${node.title}</div>` : '';
    const attribution = node.hasAttr('attribution') ? node.attr('attribution') : null;
    const citetitle = node.hasAttr('citetitle') ? node.attr('citetitle') : null;
    let attributionElement = '';
    if (attribution || citetitle) {
      const citeElement = citetitle ? `<cite>${citetitle}</cite>` : '';
      const attributionText = attribution
        ? `&#8212; ${attribution}${citetitle ? `<br${this._voidSlash}>\n` : ''}`
        : '';
      attributionElement = `\n<div class="attribution">\n${attributionText}${citeElement}\n</div>`;
    }
    return `<div${idAttribute}${classAttribute}>${titleElement}
<pre class="content">${await node.content()}</pre>${attributionElement}
</div>`
  }

  async convert_video (node) {
    const xml = this._xmlMode;
    const idAttribute = node.id ? ` id="${node.id}"` : '';
    const classes = ['videoblock'];
    if (node.hasAttr('float')) classes.push(node.attr('float'));
    if (node.hasAttr('align')) classes.push(`text-${node.attr('align')}`);
    if (node.role) classes.push(node.role);
    const classAttribute = ` class="${classes.join(' ')}"`;
    const titleElement = node.hasTitle() ? `\n<div class="title">${node.title}</div>` : '';
    const widthAttribute = node.hasAttr('width') ? ` width="${node.attr('width')}"` : '';
    const heightAttribute = node.hasAttr('height') ? ` height="${node.attr('height')}"` : '';

    switch (node.attr('poster')) {
      case 'vimeo': {
        let assetUriScheme = node.document.attr('asset-uri-scheme', 'https');
        if (assetUriScheme) assetUriScheme = `${assetUriScheme}:`;
        const startAnchor = node.hasAttr('start') ? `#at=${node.attr('start')}` : '';
        const delimiter = ['?'];
        let [target, hash] = node.attr('target').split('/', 2);
        hash ||= node.attr('hash');
        const hashParam = hash ? `${delimiter.pop() || '&amp;'}h=${hash}` : '';
        const autoplayParam = node.hasOption('autoplay') ? `${delimiter.pop() || '&amp;'}autoplay=1` : '';
        const loopParam = node.hasOption('loop') ? `${delimiter.pop() || '&amp;'}loop=1` : '';
        const mutedParam = node.hasOption('muted') ? `${delimiter.pop() || '&amp;'}muted=1` : '';
        return `<div${idAttribute}${classAttribute}>${titleElement}
<div class="content">
<iframe${widthAttribute}${heightAttribute} src="${assetUriScheme}//player.vimeo.com/video/${target}${hashParam}${autoplayParam}${loopParam}${mutedParam}${startAnchor}" frameborder="0"${node.hasOption('nofullscreen') ? '' : this._appendBooleanAttr('allowfullscreen', xml)}></iframe>
</div>
</div>`
      }
      case 'youtube': {
        let assetUriScheme = node.document.attr('asset-uri-scheme', 'https');
        if (assetUriScheme) assetUriScheme = `${assetUriScheme}:`;
        const relParamVal = node.hasOption('related') ? 1 : 0;
        const startParam = node.hasAttr('start') ? `&amp;start=${node.attr('start')}` : '';
        const endParam = node.hasAttr('end') ? `&amp;end=${node.attr('end')}` : '';
        const autoplayParam = node.hasOption('autoplay') ? '&amp;autoplay=1' : '';
        const hasLoopParam = node.hasOption('loop');
        const loopParam = hasLoopParam ? '&amp;loop=1' : '';
        const muteParam = node.hasOption('muted') ? '&amp;mute=1' : '';
        const controlsParam = node.hasOption('nocontrols') ? '&amp;controls=0' : '';
        let fsParam, fsAttribute;
        if (node.hasOption('nofullscreen')) {
          fsParam = '&amp;fs=0';
          fsAttribute = '';
        } else {
          fsParam = '';
          fsAttribute = this._appendBooleanAttr('allowfullscreen', xml);
        }
        const modestParam = node.hasOption('modest') ? '&amp;modestbranding=1' : '';
        const themeParam = node.hasAttr('theme') ? `&amp;theme=${node.attr('theme')}` : '';
        const hlParam = node.hasAttr('lang') ? `&amp;hl=${node.attr('lang')}` : '';
        let [target, list] = node.attr('target').split('/', 2);
        list ||= node.attr('list');
        let listParam;
        if (list) {
          listParam = `&amp;list=${list}`;
        } else {
          let playlist;
          const videoParts = target.split(',');
          target = videoParts[0];
          playlist = videoParts.length > 1 ? videoParts.slice(1).join(',') : null;
          playlist ||= node.attr('playlist');
          if (playlist) {
            listParam = `&amp;playlist=${target},${playlist}`;
          } else {
            listParam = hasLoopParam ? `&amp;playlist=${target}` : '';
          }
        }
        return `<div${idAttribute}${classAttribute}>${titleElement}
<div class="content">
<iframe${widthAttribute}${heightAttribute} src="${assetUriScheme}//www.youtube.com/embed/${target}?rel=${relParamVal}${startParam}${endParam}${autoplayParam}${loopParam}${muteParam}${controlsParam}${listParam}${fsParam}${modestParam}${themeParam}${hlParam}" frameborder="0"${fsAttribute}></iframe>
</div>
</div>`
      }
      case 'wistia': {
        let assetUriScheme = node.document.attr('asset-uri-scheme', 'https');
        if (assetUriScheme) assetUriScheme = `${assetUriScheme}:`;
        const delimiter = ['?'];
        const startAnchor = node.hasAttr('start') ? `${delimiter.pop() || '&amp;'}time=${node.attr('start')}` : '';
        const endVideoBehaviorParam = node.hasOption('loop')
          ? `${delimiter.pop() || '&amp;'}endVideoBehavior=loop`
          : (node.hasOption('reset') ? `${delimiter.pop() || '&amp;'}endVideoBehavior=reset` : '');
        const target = node.attr('target');
        const autoplayParam = node.hasOption('autoplay') ? `${delimiter.pop() || '&amp;'}autoPlay=true` : '';
        const mutedParam = node.hasOption('muted') ? `${delimiter.pop() || '&amp;'}muted=true` : '';
        return `<div${idAttribute}${classAttribute}>${titleElement}
<div class="content">
<iframe${widthAttribute}${heightAttribute} src="${assetUriScheme}//fast.wistia.com/embed/iframe/${target}${startAnchor}${autoplayParam}${endVideoBehaviorParam}${mutedParam}" frameborder="0"${node.hasOption('nofullscreen') ? '' : this._appendBooleanAttr('allowfullscreen', xml)} class="wistia_embed" name="wistia_embed"></iframe>
</div>
</div>`
      }
      default: {
        const posterVal = node.attr('poster');
        const posterAttribute = !posterVal ? '' : ` poster="${node.mediaUri(posterVal)}"`;
        const preloadVal = node.attr('preload');
        const preloadAttribute = !preloadVal ? '' : ` preload="${preloadVal}"`;
        const startT = node.attr('start');
        const endT = node.attr('end');
        const timeAnchor = (startT || endT) ? `#t=${startT || ''}${endT ? `,${endT}` : ''}` : '';
        return `<div${idAttribute}${classAttribute}>${titleElement}
<div class="content">
<video src="${node.mediaUri(node.attr('target'))}${timeAnchor}"${widthAttribute}${heightAttribute}${posterAttribute}${node.hasOption('autoplay') ? this._appendBooleanAttr('autoplay', xml) : ''}${node.hasOption('muted') ? this._appendBooleanAttr('muted', xml) : ''}${node.hasOption('nocontrols') ? '' : this._appendBooleanAttr('controls', xml)}${node.hasOption('loop') ? this._appendBooleanAttr('loop', xml) : ''}${preloadAttribute}>
Your browser does not support the video tag.
</video>
</div>
</div>`
      }
    }
  }

  async convert_inline_anchor (node) {
    switch (node.type) {
      case 'xref': {
        let attrs, text;
        if (node.attributes.path) {
          attrs = this._appendLinkConstraintAttrs(
            node,
            node.role ? [` class="${node.role}"`] : []
          ).join('');
          text = node.text || node.attributes.path;
        } else {
          attrs = node.role ? ` class="${node.role}"` : '';
          if (!(text = node.text)) {
            const refs = (this._refs ??= node.document.catalog.refs);
            let refid = node.attributes.refid;
            let top;
            const ref = refs[refid] ?? (!refid ? (top = this._getRootDocument(node)) : null);
            if (ref instanceof AbstractNode) {
              const resolvingSet = (this._resolvingXrefs ??= new Set());
              if (!resolvingSet.has(refid)) {
                resolvingSet.add(refid);
                const resolved = await ref.xreftext(node.attr('xrefstyle', null, true));
                resolvingSet.delete(refid);
                if (resolved) {
                  text = resolved.includes('<a') ? resolved.replace(new RegExp(DropAnchorRx.source, 'g'), '') : resolved;
                } else {
                  text = top ? '[^top]' : `[${refid}]`;
                }
              } else {
                text = top ? '[^top]' : `[${refid}]`;
              }
            } else {
              text = `[${refid}]`;
            }
          }
        }
        return `<a href="${node.target}"${attrs}>${text}</a>`
      }
      case 'ref':
        return `<a id="${node.id}"></a>`
      case 'link': {
        const attrs = node.id ? [` id="${node.id}"`] : [];
        if (node.role) attrs.push(` class="${node.role}"`);
        if (node.hasAttr('title')) attrs.push(` title="${node.attr('title')}"`);
        return `<a href="${node.target}"${this._appendLinkConstraintAttrs(node, attrs).join('')}>${node.text ?? ''}</a>`
      }
      case 'bibref':
        return `<a id="${node.id}"></a>[${node.reftext || node.id}]`
      default:
        this.logger.warn(`unknown anchor type: ${node.type}`);
        return null
    }
  }

  async convert_inline_break (node) {
    return `${node.text}<br${this._voidSlash}>`
  }

  async convert_inline_button (node) {
    return `<b class="button">${node.text}</b>`
  }

  async convert_inline_callout (node) {
    if (node.document.hasAttr('icons', 'font')) {
      return `<i class="conum" data-value="${node.text}"></i><b>(${node.text})</b>`
    }
    if (node.document.hasAttr('icons')) {
      const src = await node.iconUri(`callouts/${node.text}`);
      return `<img src="${src}" alt="${node.text}"${this._voidSlash}>`
    }
    const guard = node.attributes.guard;
    if (Array.isArray(guard)) {
      return `&lt;!--<b class="conum">(${node.text})</b>--&gt;`
    }
    return `${guard ?? ''}<b class="conum">(${node.text})</b>`
  }

  async convert_inline_footnote (node) {
    const index = node.attr('index');
    if (index) {
      if (node.type === 'xref') {
        return `<sup class="footnoteref">[<a class="footnote" href="#_footnotedef_${index}" title="View footnote.">${index}</a>]</sup>`
      }
      const idAttr = node.id ? ` id="_footnote_${node.id}"` : '';
      return `<sup class="footnote"${idAttr}>[<a id="_footnoteref_${index}" class="footnote" href="#_footnotedef_${index}" title="View footnote.">${index}</a>]</sup>`
    }
    if (node.type === 'xref') {
      return `<sup class="footnoteref red" title="Unresolved footnote reference.">[${node.text}]</sup>`
    }
    return null
  }

  async convert_inline_image (node) {
    const target = node.target;
    const type = node.type || 'image';
    let img, src;
    if (type === 'icon') {
      const icons = node.document.attr('icons');
      if (icons === 'font') {
        let iClassAttrVal = `fa fa-${target}`;
        if (node.hasAttr('size')) iClassAttrVal += ` fa-${node.attr('size')}`;
        if (node.hasAttr('flip')) {
          iClassAttrVal += ` fa-flip-${node.attr('flip')}`;
        } else if (node.hasAttr('rotate')) {
          iClassAttrVal += ` fa-rotate-${node.attr('rotate')}`;
        }
        const titleAttr = node.hasAttr('title') ? ` title="${node.attr('title')}"` : '';
        img = `<i class="${iClassAttrVal}"${titleAttr}></i>`;
      } else if (icons != null) {
        let attrs = node.hasAttr('width') ? ` width="${node.attr('width')}"` : '';
        if (node.hasAttr('height')) attrs += ` height="${node.attr('height')}"`;
        if (node.hasAttr('title')) attrs += ` title="${node.attr('title')}"`;
        img = `<img src="${await node.iconUri(target)}" alt="${this._encodeAttrValue(node.alt())}"${attrs}${this._voidSlash}>`;
      } else {
        img = `[${node.alt()}&#93;`;
      }
    } else {
      let attrs = node.hasAttr('width') ? ` width="${node.attr('width')}"` : '';
      if (node.hasAttr('height')) attrs += ` height="${node.attr('height')}"`;
      if (node.hasAttr('title')) attrs += ` title="${node.attr('title')}"`;
      if ((node.hasAttr('format', 'svg') || target.includes('.svg')) &&
        node.document.safe < SafeMode.SECURE) {
        if (node.hasOption('inline')) {
          img = await this.readSvgContents(node, target) || `<span class="alt">${node.alt()}</span>`;
        } else if (node.hasOption('interactive') && node.document.safe >= SafeMode.SERVER) {
          const fallback = node.hasAttr('fallback')
            ? `<img src="${await node.imageUri(node.attr('fallback'))}" alt="${this._encodeAttrValue(node.alt())}"${attrs}${this._voidSlash}>`
            : `<span class="alt">${node.alt()}</span>`;
          src = await node.imageUri(target);
          img = `<object type="image/svg+xml" data="${src}"${attrs}>${fallback}</object>`;
        } else {
          src = await node.imageUri(target);
          img = `<img src="${src}" alt="${this._encodeAttrValue(node.alt())}"${attrs}${this._voidSlash}>`;
        }
      } else {
        src = await node.imageUri(target);
        img = `<img src="${src}" alt="${this._encodeAttrValue(node.alt())}"${attrs}${this._voidSlash}>`;
      }
    }

    if (node.hasAttr('link')) {
      let hrefAttrVal = node.attr('link');
      if (hrefAttrVal === 'self') hrefAttrVal = src;
      if (hrefAttrVal) {
        img = `<a class="image" href="${hrefAttrVal}"${this._appendLinkConstraintAttrs(node).join('')}>${img}</a>`;
      }
    }

    const idAttr = node.id ? ` id="${node.id}"` : '';
    let classAttrVal = type;
    const role = node.role;
    if (role) {
      classAttrVal = node.hasAttr('float')
        ? `${classAttrVal} ${node.attr('float')} ${role}`
        : `${classAttrVal} ${role}`;
    } else if (node.hasAttr('float')) {
      classAttrVal = `${classAttrVal} ${node.attr('float')}`;
    }
    return `<span${idAttr} class="${classAttrVal}">${img}</span>`
  }

  async convert_inline_indexterm (node) {
    return node.type === 'visible' ? node.text : ''
  }

  async convert_inline_kbd (node) {
    const keys = node.attr('keys');
    if (keys.length === 1) {
      return `<kbd>${keys[0]}</kbd>`
    }
    return `<span class="keyseq"><kbd>${keys.join('</kbd>+<kbd>')}</kbd></span>`
  }

  async convert_inline_menu (node) {
    const caret = node.document.hasAttr('icons', 'font')
      ? '&#160;<i class="fa fa-angle-right caret"></i> '
      : '&#160;<b class="caret">&#8250;</b> ';
    const submenuJoiner = `</b>${caret}<b class="submenu">`;
    const menu = node.attr('menu');
    const submenus = node.attr('submenus');
    if (!submenus || submenus.length === 0) {
      const menuitem = node.attr('menuitem');
      if (menuitem) {
        return `<span class="menuseq"><b class="menu">${menu}</b>${caret}<b class="menuitem">${menuitem}</b></span>`
      }
      return `<b class="menuref">${menu}</b>`
    }
    return `<span class="menuseq"><b class="menu">${menu}</b>${caret}<b class="submenu">${submenus.join(submenuJoiner)}</b>${caret}<b class="menuitem">${node.attr('menuitem')}</b></span>`
  }

  async convert_inline_quoted (node) {
    const [open, close, tag] = QUOTE_TAGS$1[node.type] ?? DEFAULT_QUOTE_TAG;
    if (node.id) {
      const classAttr = node.role ? ` class="${node.role}"` : '';
      if (tag) {
        return `${open.slice(0, -1)} id="${node.id}"${classAttr}>${node.text}${close}`
      }
      return `<span id="${node.id}"${classAttr}>${open}${node.text}${close}</span>`
    }
    if (node.role) {
      if (tag) {
        return `${open.slice(0, -1)} class="${node.role}">${node.text}${close}`
      }
      return `<span class="${node.role}">${open}${node.text}${close}</span>`
    }
    return `${open}${node.text}${close}`
  }

  // NOTE expose readSvgContents for Bespoke converter
  async readSvgContents (node, target) {
    const imagesdir = node.document.attr('imagesdir');
    let resolvedPath;
    let svg;
    if (isUriish(target) || (imagesdir && isUriish(imagesdir))) {
      svg = await node.readContents(target, { start: imagesdir, normalize: true, warnOnFailure: true, label: 'SVG' });
      resolvedPath = target;
    } else {
      resolvedPath = node.normalizeSystemPath(target, imagesdir, null, { targetName: 'image' });
      svg = await node.readAsset(resolvedPath, { normalize: true, warnOnFailure: true, label: 'SVG' });
    }
    if (svg == null) return null  // file not found/readable; warning already emitted
    if (!svg) {
      node.logger.warn(`contents of SVG is empty: ${resolvedPath}`);
      return null
    }
    if (!svg.startsWith('<svg')) svg = svg.replace(SvgPreambleRx, '');
    // Fix incomplete SVG start tag (missing closing >) by inserting > before the first child element.
    // This handles cases like: <svg width="500"\n<circle .../> where the > is missing.
    svg = svg.replace(/^(<svg\b[^<>]*?)(\s*<[^/!])/s, (_, pre, rest) => `${pre.trimEnd()}>${rest}`);
    let oldStartTag = null;
    let newStartTag = null;
    let startTagMatch = null;
    for (const dim of ['width', 'height']) {
      if (!node.hasAttr(dim)) continue
      if (!newStartTag) {
        if (startTagMatch === null) startTagMatch = svg.match(SvgStartTagRx) || false;
        if (!startTagMatch) continue
        oldStartTag = startTagMatch[0];
        newStartTag = oldStartTag.replace(new RegExp(DimensionAttributeRx.source, 'g'), '');
      }
      newStartTag = `${newStartTag.slice(0, -1)} ${dim}="${node.attr(dim)}">`;
    }
    if (newStartTag) svg = `${newStartTag}${svg.slice(oldStartTag.length)}`;
    return svg
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _appendBooleanAttr (name, xml) {
    return xml ? ` ${name}="${name}"` : ` ${name}`
  }

  _appendLinkConstraintAttrs (node, attrs = []) {
    let rel = node.hasOption('nofollow') ? 'nofollow' : null;
    const window = node.attributes.window;
    if (window) {
      attrs.push(` target="${window}"`);
      if (window === '_blank' || node.hasOption('noopener')) {
        attrs.push(rel ? ` rel="${rel} noopener"` : ' rel="noopener"');
      }
    } else if (rel) {
      attrs.push(` rel="${rel}"`);
    }
    return attrs
  }

  _encodeAttrValue (val) {
    return val.includes('"') ? val.replace(/"/g, '&quot;') : val
  }

  _generateMannameSection (node) {
    let mannameTitle = node.attr('manname-title', 'Name');
    const sections = node.sections();
    if (sections.length > 0) {
      const nextSectionTitle = sections[0].title;
      if (nextSectionTitle === nextSectionTitle.toUpperCase()) {
        mannameTitle = mannameTitle.toUpperCase();
      }
    }
    const mannameId = node.attr('manname-id');
    const mannameIdAttr = mannameId ? ` id="${mannameId}"` : '';
    return `<h2${mannameIdAttr}>${mannameTitle}</h2>
<div class="sectionbody">
<p>${node.attr('mannames').join(', ')} - ${node.attr('manpurpose')}</p>
</div>`
  }

  _getRootDocument (node) {
    while ((node = node.document).isNested()) {
      node = node.parentDocument;
    }
    return node
  }
}

Html5Converter.registerFor('html5');

const html5 = /*#__PURE__*/Object.freeze({
  __proto__: null,
  default: Html5Converter
});

const ASCIIDOCTOR_CORE_VERSION = '2.0.26';

class Asciidoctor {
  /**
   * Get the version of Asciidoctor.js.
   *
   * @returns {string} - the version of Asciidoctor.js
   */
  getVersion () {
    return packageJson.version
  }

  /**
   * Get Asciidoctor core version number.
   *
   * @returns {string} - the version of Asciidoctor core (Ruby)
   */
  getCoreVersion () {
    return ASCIIDOCTOR_CORE_VERSION
  }

  get LoggerManager () {
    return LoggerManager
  }

  get MemoryLogger () {
    return MemoryLogger
  }

  get NullLogger () {
    return NullLogger
  }

  get SafeMode () {
    return SafeMode
  }

  get Timings () {
    return Timings
  }

  get Extensions () {
    return Extensions
  }

  get ConverterFactory () {
    return Converter
  }

  get Html5Converter () {
    return Html5Converter
  }

  get Block () {
    return Block
  }

  get Section () {
    return Section
  }

  get SyntaxHighlighter () {
    return SyntaxHighlighter
  }

  /**
   * Parse the AsciiDoc source input into a Document.
   *
   * @param {string|string[]|Buffer} input - the AsciiDoc source as a String, String Array, or Buffer
   * @param {Object} [options={}] - a plain object of options to control processing
   * @returns {Promise<Document>} - the parsed Document
   */
  async load (input, options = {}) {
    return load(input, options)
  }

  /**
   * Parse the AsciiDoc source input and convert it to the specified backend format.
   *
   * @param {string|string[]|Buffer} input - the AsciiDoc source as a String, String Array, or Buffer
   * @param {Object} [options={}] - a plain object of options to control processing
   * @returns {Promise<string>} - the converted output as a String
   */
  async convert (input, options = {}) {
    const doc = await load(input, options);
    return await doc.convert()
  }
}

function browser () {
  return new Asciidoctor()
}

// ESM conversion of syntax_highlighter/highlightjs.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby class SyntaxHighlighter::HighlightJsAdapter → HighlightJsAdapter extends SyntaxHighlighterBase.
//   - register_for 'highlightjs', 'highlight.js' → handled by the parent SyntaxHighlighter factory.
//   - HIGHLIGHT_JS_VERSION constant imported from constants.js.
//   - Ruby doc.attr(name, default) → doc.attr(name) with fallback using ?? operator.
//   - Ruby doc.attr? 'name' → doc.hasAttr('name').
//   - Ruby string interpolation / multiline heredocs → template literals.
//   - Ruby :head / :footer symbols → plain strings 'head' / 'footer'.


class HighlightJsAdapter extends SyntaxHighlighterBase {
  constructor (...args) {
    super(...args);
    this.name = 'highlightjs';
    this._preClass = 'highlightjs';
  }

  // Public: Wrap the source block in <pre><code> with highlight.js CSS classes.
  //
  // Adds `language-<lang>` and `hljs` to the <code> class attribute, and strips
  // the `highlight` class from <pre> when the `nohighlight-option` attribute is set.
  format (node, lang, opts) {
    const transform = (pre, code) => {
      if (node.hasAttr('nohighlight-option')) {
        pre.class = pre.class.replace(' highlight', '');
      }
      code.class = `language-${lang || 'none'} hljs`;
    };
    return super.format(node, lang, { ...opts, transform })
  }

  // Public: Always returns true — highlight.js injects markup into the document.
  hasDocinfo (location) { // eslint-disable-line no-unused-vars
    return true
  }

  // Public: Returns the CSS <link> tag (head) or the <script> tags (footer).
  //
  // location - String 'head' or 'footer'.
  // doc      - The Document being converted.
  // opts     - Plain Object with cdn_base_url and self_closing_tag_slash.
  docinfo (location, doc, opts) {
    const baseUrl = doc.attr('highlightjsdir')
      ?? `${opts.cdn_base_url}/highlight.js/${HIGHLIGHT_JS_VERSION}`;

    if (location === 'head') {
      const theme = doc.attr('highlightjs-theme') ?? 'github';
      return `<link rel="stylesheet" href="${baseUrl}/styles/${theme}.min.css"${opts.self_closing_tag_slash ?? ''}>`
    }

    // footer
    const langScripts = doc.attr('highlightjs-languages')
      ? doc.attr('highlightjs-languages')
          .split(',')
          .map(lang => `<script src="${baseUrl}/languages/${lang.trimStart()}.min.js"></script>\n`)
          .join('')
      : '';

    return `<script src="${baseUrl}/highlight.min.js"></script>
${langScripts}<script>
if (!hljs.initHighlighting.called) {
  hljs.initHighlighting.called = true
  ;[].slice.call(document.querySelectorAll('pre.highlight > code[data-lang]')).forEach(function (el) { hljs.highlightBlock(el) })
}
</script>`
  }
}

// Self-register in the global factory (mirrors Ruby's `register_for`).
SyntaxHighlighter.register(HighlightJsAdapter, 'highlightjs', 'highlight.js');

const highlightjs = /*#__PURE__*/Object.freeze({
  __proto__: null,
  HighlightJsAdapter: HighlightJsAdapter,
  default: HighlightJsAdapter
});

// Browser-specific asset reading via Fetch API.
//
// In a browser environment the document base directory is resolved as an HTTP URL,
// so "local" assets are served over HTTP rather than from the filesystem.
// This module provides a fetch-based fallback used by readContents when the
// resolved path is an HTTP/HTTPS URI (i.e. docdir was set to a browser URL).

/**
 * Fetch the text content of a URI.
 *
 * @param {string} uri - The URI to fetch.
 * @returns {Promise<string|null>} the response text, or null on failure.
 */
async function readBrowserAsset (uri) {
  try {
    const response = await fetch(uri);
    if (!response.ok) return null
    return response.text()
  } catch {
    return null
  }
}

const asset = /*#__PURE__*/Object.freeze({
  __proto__: null,
  readBrowserAsset: readBrowserAsset
});

// ESM conversion of converter/composite.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby Hash.new { |h,k| h[k] = find_converter(k) } → Map with lazy population in converterFor().
//   - Ruby respond_to?(:composed) → typeof converter.composed === 'function'.
//   - Ruby raise → throw new Error(…).
//   - backend_traits_source keyword arg → options object { backendTraitsSource }.
//   - init_backend_traits(source.backend_traits) → this.initBackendTraits(source.backendInfo()).


// ── CompositeConverter ────────────────────────────────────────────────────────
// Delegates to the first converter in the chain that handles a given transform.

class CompositeConverter {
  constructor (backend, ...args) {
    // Last argument may be an options object { backendTraitsSource }
    let opts = {};
    if (args.length > 0 && args[args.length - 1] !== null && typeof args[args.length - 1] === 'object' && !args[args.length - 1].convert) {
      opts = args.pop();
    }
    this.backend = backend;
    this.converters = args;
    applyBackendTraits(this);
    for (const converter of this.converters) {
      if (typeof converter.composed === 'function') converter.composed(this);
    }
    if (opts.backendTraitsSource) {
      this.initBackendTraits(opts.backendTraitsSource.backendInfo());
    }
    this._converterCache = new Map();
  }

  // Public: Delegates to the first converter that handles the given transform.
  //
  // node      - the AbstractNode to convert
  // transform - the optional String transform (default: node.nodeName)
  // opts      - optional hints passed to the delegate's convert method
  //
  // Returns the String result from the delegate's convert method.
  convert (node, transform = null, opts = null) {
    const t = transform ?? node.nodeName;
    return this.converterFor(t).convert(node, t, opts)
  }

  // Public: Retrieve the converter for the specified transform (cached).
  //
  // Returns the matching Converter object.
  converterFor (transform) {
    if (this._converterCache.has(transform)) return this._converterCache.get(transform)
    const converter = this._findConverter(transform);
    this._converterCache.set(transform, converter);
    return converter
  }

  // Public: Find the converter for the specified transform.
  // Throws an Error if no converter handles the transform.
  //
  // Returns the matching Converter object.
  _findConverter (transform) {
    for (const candidate of this.converters) {
      if (typeof candidate.handles === 'function' && candidate.handles(transform)) return candidate
    }
    throw new Error(`Could not find a converter to handle transform: ${transform}`)
  }
}

const composite = /*#__PURE__*/Object.freeze({
  __proto__: null,
  CompositeConverter: CompositeConverter
});

class TemplateConverter { static async create() { throw new Error("TemplateConverter is not supported in browser environments") } }

const _browser_templateConverter = /*#__PURE__*/Object.freeze({
  __proto__: null,
  TemplateConverter: TemplateConverter
});

// ESM conversion of converter/docbook5.rb
// Translated from the Ruby Asciidoctor::Converter::DocBook5Converter.
// Translation notes:
//   - Ruby symbols (:compound) → strings ('compound')
//   - Ruby predicate methods (title?, attr?, option?, has_role?, blocks?) → hasTitle(), hasAttr(), hasOption(), hasRole(), hasBlocks()
//   - Ruby `node.image_uri` → `await node.imageUri()`; `node.icon_uri` → `await node.iconUri()`
//   - common_attributes(id, role, reftext) kept as private _commonAttributes(id, role, reftext)
//   - blockquote_tag uses a content callback instead of Ruby block
//   - Ruby LF constant → '\n'
//   - document.nested? → doc.isNested(); doc.noheader → doc.isNoheader(); doc.notitle → doc.isNotitle()


const LF = '\n';

// default represents variablelist
const DLIST_TAGS = {
  qanda: { list: 'qandaset', entry: 'qandaentry', label: 'question', term: 'simpara', item: 'answer' },
  glossary: { list: null, entry: 'glossentry', term: 'glossterm', item: 'glossdef' },
};
const DLIST_TAGS_DEFAULT = { list: 'variablelist', entry: 'varlistentry', term: 'term', item: 'listitem' };

const QUOTE_TAGS = {
  monospaced:  ['<literal>', '</literal>'],
  emphasis:    ['<emphasis>', '</emphasis>', true],
  strong:      ['<emphasis role="strong">', '</emphasis>', true],
  double:      ['<quote role="double">', '</quote>', true],
  single:      ['<quote role="single">', '</quote>', true],
  mark:        ['<emphasis role="marked">', '</emphasis>'],
  superscript: ['<superscript>', '</superscript>'],
  subscript:   ['<subscript>', '</subscript>'],
};
const QUOTE_TAGS_DEFAULT = ['', '', true];

const MANPAGE_SECTION_TAGS = { section: 'refsection', synopsis: 'refsynopsisdiv' };
const TABLE_PI_NAMES = ['dbhtml', 'dbfo', 'dblatex'];

const CopyrightRx = /^(.+?)(?: ((?:\d{4}-)?\d{4}))?$/;

class DocBook5Converter extends ConverterBase {
  constructor (backend, opts = {}) {
    super(backend, opts);
  }

  async convert_document (node) {
    const result = ['<?xml version="1.0" encoding="UTF-8"?>'];
    if (node.hasAttr('toc')) {
      result.push(node.hasAttr('toclevels')
        ? `<?asciidoc-toc maxdepth="${node.attr('toclevels')}"?>`
        : '<?asciidoc-toc?>');
    }
    if (node.hasAttr('sectnums')) {
      result.push(node.hasAttr('sectnumlevels')
        ? `<?asciidoc-numbered maxdepth="${node.attr('sectnumlevels')}"?>`
        : '<?asciidoc-numbered?>');
    }
    const langAttribute = node.hasAttr('nolang') ? '' : ` xml:lang="${node.attr('lang', 'en')}"`;
    let rootTagName = node.doctype;
    let manpage = false;
    if (rootTagName === 'manpage') {
      manpage = true;
      rootTagName = 'article';
    }
    const rootTagIdx = result.length;
    const id = node.id;
    const abstract = this._findRootAbstract(node);
    if (!node.isNoheader()) result.push(await this._documentInfoTag(node, abstract));
    if (manpage) {
      result.push('<refentry>');
      result.push('<refmeta>');
      if (node.hasAttr('mantitle')) result.push(`<refentrytitle>${await node.applyReftextSubs(node.attr('mantitle'))}</refentrytitle>`);
      if (node.hasAttr('manvolnum')) result.push(`<manvolnum>${node.attr('manvolnum')}</manvolnum>`);
      result.push(`<refmiscinfo class="source">${node.attr('mansource', '&#160;')}</refmiscinfo>`);
      result.push(`<refmiscinfo class="manual">${node.attr('manmanual', '&#160;')}</refmiscinfo>`);
      result.push('</refmeta>');
      result.push('<refnamediv>');
      if (node.hasAttr('mannames')) {
        for (const n of node.attr('mannames')) result.push(`<refname>${n}</refname>`);
      }
      if (node.hasAttr('manpurpose')) result.push(`<refpurpose>${node.attr('manpurpose')}</refpurpose>`);
      result.push('</refnamediv>');
    }
    const headerDocinfo = await node.docinfo('header');
    if (headerDocinfo) result.push(headerDocinfo);
    const extractedAbstract = abstract ? this._extractAbstract(node, abstract) : null;
    if (node.hasBlocks()) {
      const blockResults = [];
      for (const b of node.blocks) blockResults.push(await b.convert());
      result.push(blockResults.filter(s => s != null).join(LF));
    }
    if (extractedAbstract) this._restoreAbstract(extractedAbstract);
    const footerDocinfo = await node.docinfo('footer');
    if (footerDocinfo) result.push(footerDocinfo);
    if (manpage) result.push('</refentry>');
    // defer adding root tag in case document ID is auto-generated on demand
    const nodeId = id ?? node.id ?? this._rootDocId;
    result.splice(rootTagIdx, 0, `<${rootTagName} xmlns="http://docbook.org/ns/docbook" xmlns:xl="http://www.w3.org/1999/xlink" version="5.0"${langAttribute}${this._commonAttributes(nodeId)}>`);
    result.push(`</${rootTagName}>`);
    return result.join(LF)
  }

  async convert_embedded (node) {
    // NOTE in DocBook 5, the root abstract must be in the info tag and is thus not part of the body
    let abstract = null;
    if (this.backend === 'docbook5') {
      abstract = this._findRootAbstract(node);
      if (abstract) this._extractAbstract(node, abstract);
    }
    const blockParts = [];
    for (const b of node.blocks) blockParts.push(await b.convert());
    const result = blockParts.filter(s => s != null).join(LF);
    if (abstract) this._restoreAbstract(abstract);
    return result
  }

  async convert_section (node) {
    let tagName = node.sectname;
    if (node.document.doctype === 'manpage') {
      tagName = MANPAGE_SECTION_TAGS[tagName] ?? tagName;
    }
    const titleEl = (node.special && (node.hasOption('notitle') || node.hasOption('untitled')))
      ? ''
      : `<title>${node.title}</title>\n`;
    return `<${tagName}${this._commonAttributes(node.id, node.role, node.reftext)}>\n${titleEl}${await node.content()}\n</${tagName}>`
  }

  async convert_admonition (node) {
    const tagName = node.attr('name');
    return `<${tagName}${this._commonAttributes(node.id, node.role, node.reftext)}>\n${this._titleTag(node)}${await this._encloseContent(node)}\n</${tagName}>`
  }

  async convert_audio (_node) { return '' }

  async convert_colist (node) {
    const result = [];
    result.push(`<calloutlist${this._commonAttributes(node.id, node.role, node.reftext)}>`);
    if (node.hasTitle()) result.push(`<title>${node.title}</title>`);
    for (const item of node.items) {
      result.push(`<callout arearefs="${item.attr('coids')}">`);
      result.push(`<para>${item.text}</para>`);
      if (item.hasBlocks()) result.push(await item.content());
      result.push('</callout>');
    }
    result.push('</calloutlist>');
    return result.join(LF)
  }

  async convert_dlist (node) {
    const result = [];
    if (node.style === 'horizontal') {
      const tagName = node.hasTitle() ? 'table' : 'informaltable';
      result.push(`<${tagName}${this._commonAttributes(node.id, node.role, node.reftext)} tabstyle="horizontal" frame="none" colsep="0" rowsep="0">`);
      result.push(`${this._titleTag(node)}<tgroup cols="2">`);
      result.push(`<colspec colwidth="${node.attr('labelwidth', 15)}*"/>`);
      result.push(`<colspec colwidth="${node.attr('itemwidth', 85)}*"/>`);
      result.push('<tbody valign="top">');
      for (const [terms, dd] of node.items) {
        result.push('<row>\n<entry>');
        for (const dt of terms) result.push(`<simpara>${dt.text}</simpara>`);
        result.push('</entry>\n<entry>');
        if (dd) {
          if (dd.hasText()) result.push(`<simpara>${dd.text}</simpara>`);
          if (dd.hasBlocks()) result.push(await dd.content());
        }
        result.push('</entry>\n</row>');
      }
      result.push(`</tbody>\n</tgroup>\n</${tagName}>`);
    } else {
      const tags = DLIST_TAGS[node.style] ?? DLIST_TAGS_DEFAULT;
      const { list: listTag, entry: entryTag, label: labelTag, term: termTag, item: itemTag } = tags;
      if (listTag) {
        result.push(`<${listTag}${this._commonAttributes(node.id, node.role, node.reftext)}>`);
        if (node.hasTitle()) result.push(`<title>${node.title}</title>`);
      }
      for (const [terms, dd] of node.items) {
        result.push(`<${entryTag}>`);
        if (labelTag) result.push(`<${labelTag}>`);
        for (const dt of terms) result.push(`<${termTag}>${dt.text}</${termTag}>`);
        if (labelTag) result.push(`</${labelTag}>`);
        result.push(`<${itemTag}>`);
        if (dd) {
          if (dd.hasText()) result.push(`<simpara>${dd.text}</simpara>`);
          if (dd.hasBlocks()) result.push(await dd.content());
        }
        result.push(`</${itemTag}>`);
        result.push(`</${entryTag}>`);
      }
      if (listTag) result.push(`</${listTag}>`);
    }
    return result.join(LF)
  }

  async convert_example (node) {
    const commonAttrs = this._commonAttributes(node.id, node.role, node.reftext);
    if (node.hasTitle()) {
      return `<example${commonAttrs}>\n<title>${node.title}</title>\n${await this._encloseContent(node)}\n</example>`
    }
    return `<informalexample${commonAttrs}>\n${await this._encloseContent(node)}\n</informalexample>`
  }

  async convert_floating_title (node) {
    return `<bridgehead${this._commonAttributes(node.id, node.role, node.reftext)} renderas="sect${node.level}">${node.title}</bridgehead>`
  }

  async convert_image (node) {
    const alignAttribute = node.hasAttr('align') ? ` align="${node.attr('align')}"` : '';
    const mediaobject = `<mediaobject>\n<imageobject>\n<imagedata fileref="${await node.imageUri(node.attr('target'))}"${this._imageSizeAttributes(node.attributes)}${alignAttribute}/>\n</imageobject>\n<textobject><phrase>${node.alt()}</phrase></textobject>\n</mediaobject>`;
    const commonAttrs = this._commonAttributes(node.id, node.role, node.reftext);
    if (node.hasTitle()) {
      return `<figure${commonAttrs}>\n<title>${node.title}</title>\n${mediaobject}\n</figure>`
    }
    return `<informalfigure${commonAttrs}>\n${mediaobject}\n</informalfigure>`
  }

  async convert_listing (node) {
    const informal = !node.hasTitle();
    const commonAttrs = this._commonAttributes(node.id, node.role, node.reftext);
    let wrappedContent;
    if (node.style === 'source') {
      const attrs = node.attributes;
      let numberingAttrs;
      if (node.hasOption('linenums')) {
        numberingAttrs = ('start' in attrs) ? ` linenumbering="numbered" startinglinenumber="${parseInt(attrs.start, 10)}"` : ' linenumbering="numbered"';
      } else {
        numberingAttrs = ' linenumbering="unnumbered"';
      }
      if ('language' in attrs) {
        wrappedContent = `<programlisting${informal ? commonAttrs : ''} language="${attrs.language}"${numberingAttrs}>${await node.content()}</programlisting>`;
      } else {
        wrappedContent = `<screen${informal ? commonAttrs : ''}${numberingAttrs}>${await node.content()}</screen>`;
      }
    } else {
      wrappedContent = `<screen${informal ? commonAttrs : ''}>${await node.content()}</screen>`;
    }
    if (informal) return wrappedContent
    return `<formalpara${commonAttrs}>\n<title>${node.title}</title>\n<para>\n${wrappedContent}\n</para>\n</formalpara>`
  }

  async convert_literal (node) {
    const commonAttrs = this._commonAttributes(node.id, node.role, node.reftext);
    if (node.hasTitle()) {
      return `<formalpara${commonAttrs}>\n<title>${node.title}</title>\n<para>\n<literallayout class="monospaced">${await node.content()}</literallayout>\n</para>\n</formalpara>`
    }
    return `<literallayout${commonAttrs} class="monospaced">${await node.content()}</literallayout>`
  }

  async convert_pass (node) { return await node.content() }

  async convert_stem (node) {
    let equation;
    const idx = node.subs ? node.subs.indexOf('specialcharacters') : -1;
    if (idx !== -1) {
      node.subs.splice(idx, 1);
      equation = await node.content();
      node.subs.splice(idx, 0, 'specialcharacters');
    } else {
      equation = await node.content();
    }
    let equationData;
    if (node.style === 'asciimath') {
      // NOTE: No AsciiMath-to-MathML conversion available in JS; use CDATA fallback
      equationData = `<mathphrase><![CDATA[${equation}]]></mathphrase>`;
    } else {
      // unhandled math (latexmath); pass source to alt and required mathphrase — dblatex will process alt as LaTeX math
      equationData = `<alt><![CDATA[${equation}]]></alt>\n<mathphrase><![CDATA[${equation}]]></mathphrase>`;
    }
    const commonAttrs = this._commonAttributes(node.id, node.role, node.reftext);
    if (node.hasTitle()) {
      return `<equation${commonAttrs}>\n<title>${node.title}</title>\n${equationData}\n</equation>`
    }
    return `<informalequation${commonAttrs}>\n${equationData}\n</informalequation>`
  }

  async convert_olist (node) {
    const result = [];
    const numAttribute = node.style ? ` numeration="${node.style}"` : '';
    const startAttribute = node.hasAttr('start') ? ` startingnumber="${node.attr('start')}"` : '';
    result.push(`<orderedlist${this._commonAttributes(node.id, node.role, node.reftext)}${numAttribute}${startAttribute}>`);
    if (node.hasTitle()) result.push(`<title>${node.title}</title>`);
    for (const item of node.items) {
      result.push(`<listitem${this._commonAttributes(item.id, item.role)}>`);
      result.push(`<simpara>${item.text}</simpara>`);
      if (item.hasBlocks()) result.push(await item.content());
      result.push('</listitem>');
    }
    result.push('</orderedlist>');
    return result.join(LF)
  }

  async convert_open (node) {
    const id = node.id;
    const role = node.role;
    const reftext = node.reftext;
    switch (node.style) {
      case 'abstract': {
        if (node.parent === node.document && node.document.doctype === 'book') {
          this.logger.warn('abstract block cannot be used in a document without a doctitle when doctype is book. Excluding block content.');
          return ''
        }
        let res = `<abstract>\n${this._titleTag(node)}${await this._encloseContent(node)}\n</abstract>`;
        const parent = node.parent;
        if (this.backend === 'docbook5' && !node.hasOption('root') &&
            (parent.context === 'open' ? parent.style === 'partintro' : parent.context === 'section' && parent.sectname === 'partintro') &&
            parent.blocks[0] === node) {
          res = `<info>\n${res}\n</info>`;
        }
        return res
      }
      case 'partintro': {
        if (node.level === 0 && node.parent.context === 'section' && node.document.doctype === 'book') {
          return `<partintro${this._commonAttributes(id, role, reftext)}>\n${this._titleTag(node)}${await this._encloseContent(node)}\n</partintro>`
        }
        this.logger.error('partintro block can only be used when doctype is book and must be a child of a book part. Excluding block content.');
        return ''
      }
      default: {
        if (node.hasTitle()) {
          const contentSpacer = node.contentModel === 'compound' ? LF : '';
          return `<formalpara${this._commonAttributes(id, role, reftext)}>\n<title>${node.title}</title>\n<para>${contentSpacer}${await node.content()}${contentSpacer}</para>\n</formalpara>`
        } else if (id || role) {
          if (node.contentModel === 'compound') {
            return `<para${this._commonAttributes(id, role, reftext)}>\n${await node.content()}\n</para>`
          }
          return `<simpara${this._commonAttributes(id, role, reftext)}>${await node.content()}</simpara>`
        }
        return await this._encloseContent(node)
      }
    }
  }

  async convert_page_break (_node) {
    return '<simpara><?asciidoc-pagebreak?></simpara>'
  }

  async convert_paragraph (node) {
    const commonAttrs = this._commonAttributes(node.id, node.role, node.reftext);
    if (node.hasTitle()) {
      return `<formalpara${commonAttrs}>\n<title>${node.title}</title>\n<para>${await node.content()}</para>\n</formalpara>`
    }
    return `<simpara${commonAttrs}>${await node.content()}</simpara>`
  }

  async convert_preamble (node) {
    if (node.document.doctype === 'book') {
      return `<preface${this._commonAttributes(node.id, node.role, node.reftext)}>\n${this._titleTag(node, false)}${await node.content()}\n</preface>`
    }
    return await node.content()
  }

  async convert_quote (node) {
    return await this._blockquoteTag(node, node.hasRole('epigraph') ? 'epigraph' : null, async () => await this._encloseContent(node))
  }

  async convert_thematic_break (_node) {
    return '<simpara><?asciidoc-hr?></simpara>'
  }

  async convert_sidebar (node) {
    return `<sidebar${this._commonAttributes(node.id, node.role, node.reftext)}>\n${this._titleTag(node)}${await this._encloseContent(node)}\n</sidebar>`
  }

  async convert_table (node) {
    let hasBody = false;
    const result = [];
    const pgwideAttribute = node.hasOption('pgwide') ? ' pgwide="1"' : '';
    let frame = node.attr('frame', 'all', 'table-frame');
    if (frame === 'ends') frame = 'topbot';
    const grid = node.attr('grid', null, 'table-grid');
    const tagName = node.hasTitle() ? 'table' : 'informaltable';
    const orientAttr = node.hasAttr('orientation', 'landscape', 'table-orientation') ? ' orient="land"' : '';
    result.push(`<${tagName}${this._commonAttributes(node.id, node.role, node.reftext)}${pgwideAttribute} frame="${frame}" rowsep="${['none', 'cols'].includes(grid) ? 0 : 1}" colsep="${['none', 'rows'].includes(grid) ? 0 : 1}"${orientAttr}>`);
    if (node.hasOption('unbreakable')) {
      result.push('<?dbfo keep-together="always"?>');
    } else if (node.hasOption('breakable')) {
      result.push('<?dbfo keep-together="auto"?>');
    }
    if (tagName === 'table') result.push(`<title>${node.title}</title>`);
    let colWidthKey;
    const width = node.hasAttr('width') ? node.attr('width') : null;
    if (width) {
      for (const piName of TABLE_PI_NAMES) result.push(`<?${piName} table-width="${width}"?>`);
      colWidthKey = 'colabswidth';
    } else {
      colWidthKey = 'colpcwidth';
    }
    result.push(`<tgroup cols="${node.attr('colcount')}">`);
    for (const col of node.columns) {
      result.push(`<colspec colname="col_${col.attr('colnumber')}" colwidth="${col.attr(colWidthKey)}*"/>`);
    }
    for (const [tsec, sectionRows] of node.rows.bySection()) {
      if (!sectionRows || sectionRows.length === 0) continue
      if (tsec === 'body') hasBody = true;
      result.push(`<t${tsec}>`);
      for (const row of sectionRows) {
        result.push('<row>');
        for (const cell of row) {
          const colspanAttribute = cell.colspan ? ` namest="col_${cell.column.attr('colnumber')}" nameend="col_${cell.column.attr('colnumber') + cell.colspan - 1}"` : '';
          const rowspanAttribute = cell.rowspan ? ` morerows="${cell.rowspan - 1}"` : '';
          const entryStart = `<entry align="${cell.attr('halign')}" valign="${cell.attr('valign')}"${colspanAttribute}${rowspanAttribute}>`;
          let cellContent;
          if (tsec === 'head') {
            cellContent = cell.text;
          } else {
            switch (cell.style) {
              case 'asciidoc':
                cellContent = await cell.content();
                break
              case 'literal':
                cellContent = `<literallayout class="monospaced">${cell.text}</literallayout>`;
                break
              case 'header': {
                const parts = await cell.content();
                cellContent = parts.length === 0 ? '' : `<simpara><emphasis role="strong">${parts.join('</emphasis></simpara><simpara><emphasis role="strong">')}</emphasis></simpara>`;
                break
              }
              default: {
                const parts = await cell.content();
                cellContent = parts.length === 0 ? '' : `<simpara>${parts.join('</simpara><simpara>')}</simpara>`;
              }
            }
          }
          const entryEnd = node.document.hasAttr('cellbgcolor')
            ? `<?dbfo bgcolor="${node.document.attr('cellbgcolor')}"?></entry>`
            : '</entry>';
          result.push(`${entryStart}${cellContent}${entryEnd}`);
        }
        result.push('</row>');
      }
      result.push(`</t${tsec}>`);
    }
    result.push('</tgroup>');
    result.push(`</${tagName}>`);
    if (!hasBody) this.logger.warn('tables must have at least one body row');
    return result.join(LF)
  }

  async convert_toc (_node) { return '' }

  async convert_ulist (node) {
    const result = [];
    if (node.style === 'bibliography') {
      result.push(`<bibliodiv${this._commonAttributes(node.id, node.role, node.reftext)}>`);
      if (node.hasTitle()) result.push(`<title>${node.title}</title>`);
      for (const item of node.items) {
        result.push('<bibliomixed>');
        result.push(`<bibliomisc>${item.text}</bibliomisc>`);
        if (item.hasBlocks()) result.push(await item.content());
        result.push('</bibliomixed>');
      }
      result.push('</bibliodiv>');
    } else {
      const checklist = node.hasOption('checklist');
      const markType = checklist ? 'none' : node.style;
      const markAttribute = markType ? ` mark="${markType}"` : '';
      result.push(`<itemizedlist${this._commonAttributes(node.id, node.role, node.reftext)}${markAttribute}>`);
      if (node.hasTitle()) result.push(`<title>${node.title}</title>`);
      for (const item of node.items) {
        const textMarker = (checklist && item.hasAttr('checkbox'))
          ? (item.hasAttr('checked') ? '&#10003; ' : '&#10063; ')
          : '';
        result.push(`<listitem${this._commonAttributes(item.id, item.role)}>`);
        result.push(`<simpara>${textMarker}${item.text}</simpara>`);
        if (item.hasBlocks()) result.push(await item.content());
        result.push('</listitem>');
      }
      result.push('</itemizedlist>');
    }
    return result.join(LF)
  }

  async convert_verse (node) {
    return await this._blockquoteTag(node, node.hasRole('epigraph') ? 'epigraph' : null, async () => `<literallayout>${await node.content()}</literallayout>`)
  }

  async convert_video (_node) { return '' }

  async convert_inline_anchor (node) {
    switch (node.type) {
      case 'ref':
        return `<anchor${this._commonAttributes(node.id, null, node.reftext || `[${node.id}]`)}/>`
      case 'xref': {
        const path = node.attributes.path;
        if (path) {
          return `<link xl:href="${node.target}">${node.text || path}</link>`
        }
        let linkend = node.attributes.refid;
        if (!linkend) {
          const rootDoc = this._getRootDocument(node);
          linkend = rootDoc.id ?? (this._rootDocId ??= this._generateDocumentId(rootDoc));
        }
        return node.text ? `<link linkend="${linkend}">${node.text}</link>` : `<xref linkend="${linkend}"/>`
      }
      case 'link':
        return `<link xl:href="${node.target}">${node.text}</link>`
      case 'bibref': {
        const text = `[${node.reftext || node.id}]`;
        return `<anchor${this._commonAttributes(node.id, null, text)}/>${text}`
      }
      default:
        this.logger.warn(`unknown anchor type: ${node.type}`);
        return null
    }
  }

  async convert_inline_break (node) {
    return `${node.text}<?asciidoc-br?>`
  }

  async convert_inline_button (node) {
    return `<guibutton>${node.text}</guibutton>`
  }

  async convert_inline_callout (node) {
    return `<co${this._commonAttributes(node.id)}/>`
  }

  async convert_inline_footnote (node) {
    if (node.type === 'xref') {
      return `<footnoteref linkend="${node.target}"/>`
    }
    return `<footnote${this._commonAttributes(node.id)}><simpara>${node.text}</simpara></footnote>`
  }

  async convert_inline_image (node) {
    const fileref = node.type === 'icon' ? await node.iconUri(node.target) : await node.imageUri(node.target);
    const img = `<inlinemediaobject${this._commonAttributes(node.id, node.role)}>\n<imageobject>\n<imagedata fileref="${fileref}"${this._imageSizeAttributes(node.attributes)}/>\n</imageobject>\n<textobject><phrase>${node.alt()}</phrase></textobject>\n</inlinemediaobject>`;
    if (node.type !== 'icon' && node.hasAttr('link')) {
      const linkHref = node.attr('link');
      return `<link xl:href="${linkHref === 'self' ? fileref : linkHref}">${img}</link>`
    }
    return img
  }

  async convert_inline_indexterm (node) {
    let rel = '';
    const see = node.attr('see');
    if (see) {
      rel = `\n<see>${see}</see>`;
    } else {
      const seeAlsoList = node.attr('see-also');
      if (seeAlsoList) {
        rel = seeAlsoList.map(s => `\n<seealso>${s}</seealso>`).join('');
      }
    }
    if (node.type === 'visible') {
      return `<indexterm>\n<primary>${node.text}</primary>${rel}\n</indexterm>${node.text}`
    }
    const terms = node.attr('terms');
    const numterms = terms.length;
    const indexPromote = node.document.hasOption('indexterm-promotion');
    if (numterms > 2) {
      return `<indexterm>\n<primary>${terms[0]}</primary><secondary>${terms[1]}</secondary><tertiary>${terms[2]}</tertiary>${rel}\n</indexterm>${indexPromote ? `\n<indexterm>\n<primary>${terms[1]}</primary><secondary>${terms[2]}</secondary>\n</indexterm>\n<indexterm>\n<primary>${terms[2]}</primary>\n</indexterm>` : ''}`
    } else if (numterms > 1) {
      return `<indexterm>\n<primary>${terms[0]}</primary><secondary>${terms[1]}</secondary>${rel}\n</indexterm>${indexPromote ? `\n<indexterm>\n<primary>${terms[1]}</primary>\n</indexterm>` : ''}`
    }
    return `<indexterm>\n<primary>${terms[0]}</primary>${rel}\n</indexterm>`
  }

  async convert_inline_kbd (node) {
    const keys = node.attr('keys');
    if (keys.length === 1) {
      return `<keycap>${keys[0]}</keycap>`
    }
    return `<keycombo><keycap>${keys.join('</keycap><keycap>')}</keycap></keycombo>`
  }

  async convert_inline_menu (node) {
    const menu = node.attr('menu');
    const submenus = node.attr('submenus');
    if (!submenus || submenus.length === 0) {
      const menuitem = node.attr('menuitem');
      if (menuitem) {
        return `<menuchoice><guimenu>${menu}</guimenu> <guimenuitem>${menuitem}</guimenuitem></menuchoice>`
      }
      return `<guimenu>${menu}</guimenu>`
    }
    return `<menuchoice><guimenu>${menu}</guimenu> <guisubmenu>${submenus.join('</guisubmenu> <guisubmenu>')}</guisubmenu> <guimenuitem>${node.attr('menuitem')}</guimenuitem></menuchoice>`
  }

  async convert_inline_quoted (node) {
    const type = node.type;
    if (type === 'asciimath' || type === 'latexmath') {
      const equation = node.text;
      if (type === 'asciimath') {
        return `<inlineequation><mathphrase><![CDATA[${equation}]]></mathphrase></inlineequation>`
      }
      return `<inlineequation><alt><![CDATA[${equation}]]></alt><mathphrase><![CDATA[${equation}]]></mathphrase></inlineequation>`
    }
    const [open, close, supportsPhrase] = QUOTE_TAGS[type] ?? QUOTE_TAGS_DEFAULT;
    const text = node.text;
    let quotedText;
    if (node.role) {
      if (supportsPhrase) {
        quotedText = `${open}<phrase role="${node.role}">${text}</phrase>${close}`;
      } else {
        // chop the closing > from open tag to insert role attribute
        quotedText = `${open.slice(0, -1)} role="${node.role}">${text}${close}`;
      }
    } else {
      quotedText = `${open}${text}${close}`;
    }
    return node.id ? `<anchor${this._commonAttributes(node.id)}/>${quotedText}` : quotedText
  }

  // Private helpers

  _commonAttributes (id, role = null, reftext = null) {
    let attrs = '';
    if (id) {
      attrs = ` xml:id="${id}"${role ? ` role="${role}"` : ''}`;
    } else if (role) {
      attrs = ` role="${role}"`;
    }
    if (reftext) {
      let sanitized = reftext;
      if (sanitized.includes('<')) {
        sanitized = sanitized.replace(XmlSanitizeRx, '');
        if (sanitized.includes(' ')) sanitized = sanitized.replace(/ {2,}/g, ' ').trim();
      }
      if (sanitized.includes('"')) sanitized = sanitized.replace(/"/g, '&quot;');
      return `${attrs} xreflabel="${sanitized}"`
    }
    return attrs
  }

  _imageSizeAttributes (attributes) {
    if ('scaledwidth' in attributes) {
      return ` width="${attributes.scaledwidth}"`
    } else if ('scale' in attributes) {
      return ` scale="${attributes.scale}"`
    }
    const widthAttr = ('width' in attributes) ? ` contentwidth="${attributes.width}"` : '';
    const depthAttr = ('height' in attributes) ? ` contentdepth="${attributes.height}"` : '';
    return `${widthAttr}${depthAttr}`
  }

  _authorTag (doc, author) {
    const result = ['<author>', '<personname>'];
    if (author.firstname) result.push(`<firstname>${doc.subReplacements(author.firstname)}</firstname>`);
    if (author.middlename) result.push(`<othername>${doc.subReplacements(author.middlename)}</othername>`);
    if (author.lastname) result.push(`<surname>${doc.subReplacements(author.lastname)}</surname>`);
    result.push('</personname>');
    if (author.email) result.push(`<email>${author.email}</email>`);
    result.push('</author>');
    return result.join(LF)
  }

  async _documentInfoTag (doc, abstract) {
    const result = ['<info>'];
    if (!doc.isNotitle()) {
      const title = doc.doctitle({ partition: true, use_fallback: true });
      if (title && title.subtitle) {
        result.push(`<title>${title.main}</title>\n<subtitle>${title.subtitle}</subtitle>`);
      } else if (title) {
        result.push(`<title>${title}</title>`);
      }
    }
    const date = doc.hasAttr('revdate') ? doc.attr('revdate') : (doc.hasAttr('reproducible') ? null : doc.attr('docdate'));
    if (date) result.push(`<date>${date}</date>`);
    if (doc.hasAttr('copyright')) {
      const m = CopyrightRx.exec(doc.attr('copyright'));
      if (m) {
        result.push('<copyright>');
        result.push(`<holder>${m[1]}</holder>`);
        if (m[2]) result.push(`<year>${m[2]}</year>`);
        result.push('</copyright>');
      }
    }
    if (doc.hasHeader()) {
      const authors = doc.authors();
      if (authors.length > 0) {
        if (authors.length > 1) {
          result.push('<authorgroup>');
          for (const author of authors) result.push(this._authorTag(doc, author));
          result.push('</authorgroup>');
        } else {
          const author = authors[0];
          result.push(this._authorTag(doc, author));
          if (author.initials) result.push(`<authorinitials>${author.initials}</authorinitials>`);
        }
      }
      if (doc.hasAttr('revdate') && (doc.hasAttr('revnumber') || doc.hasAttr('revremark'))) {
        result.push('<revhistory>\n<revision>');
        if (doc.hasAttr('revnumber')) result.push(`<revnumber>${doc.attr('revnumber')}</revnumber>`);
        if (doc.hasAttr('revdate')) result.push(`<date>${doc.attr('revdate')}</date>`);
        if (doc.hasAttr('authorinitials')) result.push(`<authorinitials>${doc.attr('authorinitials')}</authorinitials>`);
        if (doc.hasAttr('revremark')) result.push(`<revremark>${doc.attr('revremark')}</revremark>`);
        result.push('</revision>\n</revhistory>');
      }
      if (doc.hasAttr('front-cover-image') || doc.hasAttr('back-cover-image')) {
        const backCoverTag = await this._coverTag(doc, 'back');
        if (backCoverTag) {
          result.push(await this._coverTag(doc, 'front', true));
          result.push(backCoverTag);
        } else {
          const frontCoverTag = await this._coverTag(doc, 'front');
          if (frontCoverTag) result.push(frontCoverTag);
        }
      }
      if (doc.hasAttr('orgname')) result.push(`<orgname>${doc.attr('orgname')}</orgname>`);
      const docinfo = await doc.docinfo();
      if (docinfo) result.push(docinfo);
    }
    if (abstract) {
      abstract.setAttr('root-option', '');
      result.push(await this.convert(abstract, abstract.nodeName));
      abstract.removeAttr('root-option');
    }
    result.push('</info>');
    return result.join(LF)
  }

  _findRootAbstract (doc) {
    if (!doc.hasBlocks()) return null
    let firstBlock = doc.blocks[0];
    if (firstBlock.context === 'preamble') {
      if (!firstBlock.hasBlocks()) return null
      firstBlock = firstBlock.blocks[0];
    } else if (firstBlock.context === 'section') {
      if (firstBlock.sectname === 'abstract') return firstBlock
      if (firstBlock.sectname !== 'preface' || !firstBlock.hasBlocks()) return null
      firstBlock = firstBlock.blocks[0];
    }
    return (firstBlock.style === 'abstract' && firstBlock.context === 'open') ? firstBlock : null
  }

  _extractAbstract (document, abstract) {
    let parent = abstract.parent;
    let toDelete = abstract;
    while (parent !== document && parent.blocks.length === 1) {
      toDelete = parent;
      parent = parent.parent;
    }
    parent.blocks.splice(parent.blocks.indexOf(toDelete), 1);
    return abstract
  }

  _restoreAbstract (abstract) {
    abstract.parent.blocks.unshift(abstract);
  }

  _getRootDocument (node) {
    let doc = node.document;
    while (doc.isNested()) doc = doc.parentDocument;
    return doc
  }

  _generateDocumentId (doc) {
    return `__${doc.doctype}-root__`
  }

  async _encloseContent (node) {
    return node.contentModel === 'compound' ? await node.content() : `<simpara>${await node.content()}</simpara>`
  }

  _titleTag (node, optional = true) {
    if (optional && !node.hasTitle()) return ''
    return `<title>${node.title ?? ''}</title>\n`
  }

  async _coverTag (doc, face, usePlaceholder = false) {
    const coverImage = doc.attr(`${face}-cover-image`);
    if (coverImage) {
      let fileref = coverImage;
      let sizeAttrs = '';
      // Check if it's an image macro (contains ':')
      if (coverImage.includes(':')) {
        const m = /^image::?(\S|\S.*?\S)\[(.*?)?\]$/.exec(coverImage);
        if (m) {
          fileref = await doc.imageUri(m[1]);
          // size attrs parsing omitted for simplicity
        }
      }
      return `<cover role="${face}">\n<mediaobject>\n<imageobject>\n<imagedata fileref="${fileref}"${sizeAttrs}/>\n</imageobject>\n</mediaobject>\n</cover>`
    }
    if (usePlaceholder) return `<cover role="${face}"/>`
    return null
  }

  async _blockquoteTag (node, tagName, contentFn) {
    const tag = tagName || 'blockquote';
    const result = [`<${tag}${this._commonAttributes(node.id, node.role, node.reftext)}>`];
    if (node.hasTitle()) result.push(`<title>${node.title}</title>`);
    if (node.hasAttr('attribution') || node.hasAttr('citetitle')) {
      result.push('<attribution>');
      if (node.hasAttr('attribution')) result.push(node.attr('attribution'));
      if (node.hasAttr('citetitle')) result.push(`<citetitle>${node.attr('citetitle')}</citetitle>`);
      result.push('</attribution>');
    }
    result.push(await contentFn());
    result.push(`</${tag}>`);
    return result.join(LF)
  }
}

const docbook5 = /*#__PURE__*/Object.freeze({
  __proto__: null,
  DocBook5Converter: DocBook5Converter,
  default: DocBook5Converter
});

// ESM conversion of converter/manpage.rb
//
// Ruby-to-JavaScript notes:
//   - Ruby module constants (WHITESPACE, ESC, …) → module-level const
//   - Ruby symbol keys (:preserve, :normalize, :collapse) → plain strings
//   - node.attr?  → node.hasAttr()
//   - node.title? → node.hasTitle()
//   - node.blocks? → node.hasBlocks()
//   - node.footnotes? → node.hasFootnotes()
//   - node.noheader → node.isNoheader()
//   - node.authors → node.authors() (method call)
//   - node.footnotes → node.footnotes (getter)
//   - await node.content() → await node.content() (method call)
//   - node.text → node.text (property/getter)
//   - node.captioned_title → node.captionedTitle()
//   - node.content_model == :compound → node.contentModel === 'compound'
//   - node.rows.to_h.each { |tsec, rows| } → for (const [tsec, rows] of node.rows.bySection())
//   - node.media_uri target → node.mediaUri(target)
//   - AbstractNode === ref → ref instanceof AbstractNode
//   - node.context === :section → node.context === 'section'
//   - node.document.catalog[:refs] → node.document.catalog.refs
//   - Ruby gsub blocks with $1, $2 → replace callbacks with (m, $1, $2, ...)
//   - Ruby str.tr_s(WHITESPACE, ' ') → str.replace(/[\n\t ]+/g, ' ')
//   - Ruby str.rstrip → str.trimEnd()
//   - Ruby str.lstrip → str.trimStart()
//   - self.write_alternate_pages → static writeAlternatePages; uses lazy node:fs import
//   - (^)? capture of zero-width anchor: Ruby empty string is truthy, JS empty string is falsy
//     → use ($1 !== undefined) instead of ($1) in preserve-whitespace handler

const ET         = ' '.repeat(8);    // expand tab to 8 spaces
const ESC        = '\u001b';         // troff leader marker
const ESC_BS     = `${ESC}\\`;       // escaped backslash (troff formatting sequence)
const ESC_FS     = `${ESC}.`;        // escaped full stop (troff macro)

// ── Module-level regular expressions ─────────────────────────────────────────

// Matches a literal backslash at string start (^\\) OR an optionally ESC-prefixed backslash
// Replacement rule: if ESC-prefixed ($1 set) → keep as-is; otherwise → \\(rs
const LiteralBackslashRx  = /^\\|(\u001b)?\\/g;

// Matches a leading period on any line (troff macro indicator)
const LeadingPeriodRx     = /^\./gm;

// Matches a full escaped URL/MTO macro line (possibly prefixed by orphaned \c line)
const EscapedMacroRx      = /^(?:\u001b\\c\n)?\u001b\.((?:URL|MTO) ".*?" ".*?" )( |[^\s]*)(.*?)(?: *\u001b\\c)?$/gm;

// Matches malformed escaped macros (orphaned \c followed by ESC macro without newline)
const MalformedEscapedMacroRx = /(\u001b\\c) (\u001b\.(?:URL|MTO) )/g;

// Matches mock XML boundary markers used to avoid artificial word-breaks
const MockMacroRx         = /<\/?([\u001b]\\[^>]+)>/g;

// HTML entity references for em-dash and ellipsis
const EmDashCharRefRx     = /&#8212;(?:&#8203;)?/g;
const EllipsisCharRefRx   = /&#8230;(?:&#8203;)?/g;

// Whitespace normalisation: optional blanks around a newline → single newline
const WrappedIndentRx     = /[ \t]*\n[ \t]*/g;

// Detects any XML/entity markup in a string (used by uppercase_pcdata)
const XMLMarkupRx         = /&#?[a-z\d]+;|</;

// Splits a string into entity refs / fake-XML spans / monospaced spans / plain text
const PCDATAFilterRx      = /(&#?[a-z\d]+;|<\u001b\\f\(CR[\s\S]*?<\/\u001b\\fP>|<[^>]+>)|([^&<]+)/g;

// ── ManPageConverter ──────────────────────────────────────────────────────────

class ManPageConverter extends ConverterBase {
  constructor (backend, opts = {}) {
    super(backend, opts);
    this.initBackendTraits({
      basebackend: 'manpage',
      filetype: 'man',
      outfilesuffix: '.man',
      supportsTemplates: true,
    });
  }

  async convert_document (node) {
    if (!node.hasAttr('mantitle')) {
      throw new Error('asciidoctor: ERROR: doctype must be set to manpage when using manpage backend')
    }
    const mantitle   = node.attr('mantitle').replace(InvalidSectionIdCharsRx, '');
    const manvolnum  = node.attr('manvolnum', '1');
    const manname    = node.attr('manname', mantitle);
    const manmanual  = node.attr('manmanual');
    const mansource  = node.attr('mansource');
    const docdate    = node.hasAttr('reproducible') ? null : node.attr('docdate');

    // NOTE the first line enables the table (tbl) preprocessor, necessary for non-Linux systems
    const result = [`'\\" t
.\\"     Title: ${mantitle}
.\\"    Author: ${node.hasAttr('authors') ? node.attr('authors') : '[see the "AUTHOR(S)" section]'}
.\\" Generator: Asciidoctor ${node.attr('asciidoctor-version')}`];

    if (docdate) result.push(`.\\"      Date: ${docdate}`);

    result.push(`.\\"    Manual: ${manmanual ? manmanual.replace(/[\n\t ]+/g, ' ') : '\\ \\&'}
.\\"    Source: ${mansource ? mansource.replace(/[\n\t ]+/g, ' ') : '\\ \\&'}
.\\"  Language: English
.\\"`);

    // TODO add document-level setting to disable capitalization of manname
    result.push(`.TH "${this.manify(manname.toUpperCase())}" "${manvolnum}" "${docdate ?? ''}" "${mansource ? this.manify(mansource) : '\\ \\&'}" "${manmanual ? this.manify(manmanual) : '\\ \\&'}"`);

    // define portability settings
    // see http://bugs.debian.org/507673
    // see http://lists.gnu.org/archive/html/groff/2009-02/msg00013.html
    result.push('.ie \\n(.g .ds Aq \\(aq');
    result.push('.el       .ds Aq \'');
    // set sentence_space_size to 0 to prevent extra space between sentences separated by a newline
    result.push('.ss \\n[.ss] 0');
    // disable hyphenation
    result.push('.nh');
    // disable justification (adjust text to left margin only)
    result.push('.ad l');
    // define URL macro for portability
    // see http://web.archive.org/web/20060102165607/http://people.debian.org/~branden/talks/wtfm/wtfm.pdf
    //
    // Usage
    //
    // .URL "http://www.debian.org" "Debian" "."
    //
    // * First argument: the URL
    // * Second argument: text to be hyperlinked
    // * Third (optional) argument: text that needs to immediately trail the hyperlink without intervening whitespace
    result.push(`.de URL
\\fI\\\\$2\\fP <\\\\$1>\\\\$3
..
.als MTO URL
.if \\n[.g] \\{\\
.  mso www.tmac
.  am URL
.    ad l
.  .
.  am MTO
.    ad l
.  .`);
    result.push(`.  LINKSTYLE ${node.attr('man-linkstyle', 'blue R < >')}`);
    result.push('.\\}');

    if (!node.isNoheader()) {
      if (node.hasAttr('manpurpose')) {
        const mannames = node.attr('mannames', [manname]);
        result.push(`.SH "${(node.attr('manname-title', 'NAME')).toUpperCase()}"
${mannames.map(n => this.manify(n).replace(/\\-/g, '-')).join(', ')} \\- ${this.manify(node.attr('manpurpose'), { whitespace: 'normalize' })}`);
      }
    }

    result.push(await node.content());

    // QUESTION should NOTES come after AUTHOR(S)?
    this._appendFootnotes(result, node);

    const authors = node.authors();
    if (authors.length > 0) {
      if (authors.length > 1) {
        result.push('.SH "AUTHORS"');
        for (const author of authors) {
          result.push(`.sp\n${author.name}`);
        }
      } else {
        result.push(`.SH "AUTHOR"\n.sp\n${authors[0].name}`);
      }
    }

    return result.join(LF$1)
  }

  // NOTE embedded doesn't really make sense in the manpage backend
  async convert_embedded (node) {
    const result = [await node.content()];
    this._appendFootnotes(result, node);
    // QUESTION should we add an AUTHOR(S) section?
    return result.join(LF$1)
  }

  async convert_section (node) {
    let macro, stitle;
    if (node.level > 1) {
      macro  = 'SS';
      // QUESTION why captioned title? why not when level == 1?
      stitle = node.captionedTitle();
    } else {
      macro  = 'SH';
      stitle = this._uppercasePcdata(node.title);
    }
    return `.${macro} "${this.manify(stitle)}"\n${await node.content()}`
  }

  async convert_admonition (node) {
    const titleSuffix = node.hasTitle() ? `\\fP: ${this.manify(node.title)}` : '';
    return `.if n .sp
.RS 4
.it 1 an-trap
.nr an-no-space-flag 1
.nr an-break-flag 1
.br
.ps +1
.B ${node.attr('textlabel')}${titleSuffix}
.ps -1
.br
${await this._encloseContent(node)}
.sp .5v
.RE`
  }

  async convert_colist (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.title)}\n.br`);
    }
    result.push('.TS\ntab(:);\nr lw(\\n(.lu*75u/100u).');

    let num = 0;
    for (const item of node.items) {
      result.push(`\\fB(${++num})\\fP\\h'-2n':T{`);
      result.push(this.manify(item.text, { whitespace: 'normalize' }));
      if (item.hasBlocks()) result.push(await item.content());
      result.push('T}');
    }
    result.push('.TE');
    return result.join(LF$1)
  }

  // TODO implement horizontal (if it makes sense)
  async convert_dlist (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.title)}\n.br`);
    }
    let counter = 0;
    for (const [terms, dd] of node.items) {
      counter++;
      if (node.style === 'qanda') {
        result.push(`.sp\n${counter}. ${this.manify(terms.map(dt => dt.text).join(' '))}\n.RS 4`);
      } else {
        result.push(`.sp\n${this.manify(terms.map(dt => dt.text).join(', '), { whitespace: 'normalize' })}\n.RS 4`);
      }
      if (dd) {
        let hasText = false;
        if (dd.hasText()) {
          result.push(this.manify(dd.text, { whitespace: 'normalize' }));
          hasText = true;
        }
        if (dd.hasBlocks()) {
          let ddContent = await dd.content();
          if (!hasText && ddContent.startsWith('.sp\n')) {
            ddContent = ddContent.slice(4);
          }
          result.push(ddContent);
        }
      }
      result.push('.RE');
    }
    return result.join(LF$1)
  }

  async convert_example (node) {
    const titleBlock = node.hasTitle()
      ? `.sp\n.B ${this.manify(node.captionedTitle())}\n.br`
      : '.sp';
    return `${titleBlock}\n.RS 4\n${await this._encloseContent(node)}\n.RE`
  }

  async convert_floating_title (node) {
    return `.SS "${this.manify(node.title)}"`
  }

  async convert_image (node) {
    const titleBlock = node.hasTitle()
      ? `.sp\n.B ${this.manify(node.captionedTitle())}\n.br`
      : '.sp';
    return `${titleBlock}\n[${this.manify(node.attr('alt'))}]`
  }

  async convert_listing (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.captionedTitle())}\n.br`);
    }
    result.push(`.sp
.if n .RS 4
.nf
.fam C
${this.manify(await node.content(), { whitespace: 'preserve' })}
.fam
.fi
.if n .RE`);
    return result.join(LF$1)
  }

  async convert_literal (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.title)}\n.br`);
    }
    result.push(`.sp
.if n .RS 4
.nf
.fam C
${this.manify(await node.content(), { whitespace: 'preserve' })}
.fam
.fi
.if n .RE`);
    return result.join(LF$1)
  }

  async convert_sidebar (node) {
    const titleBlock = node.hasTitle()
      ? `.sp\n.B ${this.manify(node.title)}\n.br`
      : '.sp';
    return `${titleBlock}\n.RS 4\n${await this._encloseContent(node)}\n.RE`
  }

  async convert_olist (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.title)}\n.br`);
    }

    const start = parseInt(node.attr('start', 1), 10);
    let idx = 0;
    for (const item of node.items) {
      const numeral = idx + start;
      const listText = this.manify(item.text, { whitespace: 'normalize' });
      result.push(`.sp
.RS 4
.ie n \\{\\
\\h'-04' ${numeral}.\\h'+01'\\c
.\\}
.el \\{\\
.  sp -1
.  IP " ${numeral}." 4.2
.\\}${listText === '' ? '' : LF$1 + listText}`);
      if (item.hasBlocks()) {
        let itemContent = await item.content();
        if (listText === '' && itemContent.startsWith('.sp\n')) {
          itemContent = itemContent.slice(4);
        }
        result.push(itemContent);
      }
      result.push('.RE');
      idx++;
    }
    return result.join(LF$1)
  }

  async convert_open (node) {
    if (node.style === 'abstract' || node.style === 'partintro') {
      return this._encloseContent(node)
    }
    return await node.content()
  }

  async convert_page_break (_node) {
    return '.bp'
  }

  async convert_paragraph (node) {
    if (node.hasTitle()) {
      return `.sp\n.B ${this.manify(node.title)}\n.br\n${this.manify(await node.content(), { whitespace: 'normalize' })}`
    }
    return `.sp\n${this.manify(await node.content(), { whitespace: 'normalize' })}`
  }

  async convert_pass (node) {
    return this.contentOnly(node)
  }

  async convert_preamble (node) {
    return this.contentOnly(node)
  }

  async convert_quote (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.RS 3\n.B ${this.manify(node.title)}\n.br\n.RE`);
    }
    let attributionLine = node.hasAttr('citetitle') ? `${node.attr('citetitle')} ` : null;
    if (node.hasAttr('attribution')) {
      attributionLine = `${attributionLine ?? ''}\\(em ${node.attr('attribution')}`;
    } else {
      attributionLine = null;
    }
    result.push(`.RS 3\n.ll -.6i\n${await this._encloseContent(node)}\n.br\n.RE\n.ll`);
    if (attributionLine) {
      result.push(`.RS 5\n.ll -.10i\n${attributionLine}\n.RE\n.ll`);
    }
    return result.join(LF$1)
  }

  async convert_stem (node) {
    const result = [];
    result.push(node.hasTitle() ? `.sp\n.B ${this.manify(node.title)}\n.br` : '.sp');
    const style = node.style;
    const [open, close] = BLOCK_MATH_DELIMITERS[style] ?? ['', ''];
    let equation = await node.content();
    if (equation.startsWith(open) && equation.endsWith(close)) {
      equation = equation.slice(open.length, equation.length - close.length);
    }
    result.push(`${this.manify(equation, { whitespace: 'preserve' })} (${style})`);
    return result.join(LF$1)
  }

  // NOTE This handler inserts empty cells to account for colspans and rowspans.
  // In order to support colspans and rowspans properly, that information must
  // be computed up front and consulted when rendering the cell as this information
  // is not available on the cell itself.
  async convert_table (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp
.it 1 an-trap
.nr an-no-space-flag 1
.nr an-break-flag 1
.br
.B ${this.manify(node.captionedTitle())}
`);
    }
    result.push(`.TS\nallbox tab(:);`);

    const rowHeader = [];
    const rowText   = [];
    let rowIndex    = 0;

    for (const [tsec, rows] of node.rows.bySection()) {
      if (rows.length === 0) continue
      for (const row of rows) {
        rowHeader[rowIndex] = rowHeader[rowIndex] ?? [];
        rowText[rowIndex]   = rowText[rowIndex]   ?? [];
        let remainingCells  = row.length;
        let cellIndex = 0;
        for (const cell of row) {
          remainingCells--;
          rowHeader[rowIndex][cellIndex] = rowHeader[rowIndex][cellIndex] ?? [];
          // add an empty cell as a placeholder if this is a rowspan cell
          if (JSON.stringify(rowHeader[rowIndex][cellIndex]) === JSON.stringify(['^t'])) {
            rowText[rowIndex].push(`T{${LF$1}T}:`);
          }
          rowText[rowIndex].push(`T{${LF$1}`);
          const cellHalign = (cell.attr('halign', 'left') ?? 'left')[0];
          if (tsec === 'body') {
            if (rowHeader[rowIndex].length === 0 || rowHeader[rowIndex][cellIndex].length === 0) {
              rowHeader[rowIndex][cellIndex].push(`${cellHalign}t`);
            } else {
              rowHeader[rowIndex][cellIndex + 1] = rowHeader[rowIndex][cellIndex + 1] ?? [];
              rowHeader[rowIndex][cellIndex + 1].push(`${cellHalign}t`);
            }
            let cellContent;
            if (cell.style === 'asciidoc') {
              cellContent = await cell.content();
            } else if (cell.style === 'literal') {
              cellContent = `.nf${LF$1}${this.manify(cell.text, { whitespace: 'preserve' })}${LF$1}.fi`;
            } else {
              cellContent = (await cell.content()).map(p => this.manify(p, { whitespace: 'normalize' })).join(`${LF$1}.sp${LF$1}`);
            }
            rowText[rowIndex].push(`${cellContent}${LF$1}`);
          } else { // tsec === 'head' || tsec === 'foot'
            if (rowHeader[rowIndex].length === 0 || rowHeader[rowIndex][cellIndex].length === 0) {
              rowHeader[rowIndex][cellIndex].push(`${cellHalign}tB`);
            } else {
              rowHeader[rowIndex][cellIndex + 1] = rowHeader[rowIndex][cellIndex + 1] ?? [];
              rowHeader[rowIndex][cellIndex + 1].push(`${cellHalign}tB`);
            }
            rowText[rowIndex].push(`${this.manify(cell.text, { whitespace: 'normalize' })}${LF$1}`);
          }
          if (cell.colspan && cell.colspan > 1) {
            for (let i = 0; i < cell.colspan - 1; i++) {
              if (rowHeader[rowIndex].length === 0 || rowHeader[rowIndex][cellIndex].length === 0) {
                rowHeader[rowIndex][cellIndex + i].push('st');
              } else {
                rowHeader[rowIndex][cellIndex + 1 + i] = rowHeader[rowIndex][cellIndex + 1 + i] ?? [];
                rowHeader[rowIndex][cellIndex + 1 + i].push('st');
              }
            }
          }
          if (cell.rowspan && cell.rowspan > 1) {
            for (let i = 0; i < cell.rowspan - 1; i++) {
              rowHeader[rowIndex + 1 + i] = rowHeader[rowIndex + 1 + i] ?? [];
              if (rowHeader[rowIndex + 1 + i].length === 0 || (rowHeader[rowIndex + 1 + i][cellIndex] ?? []).length === 0) {
                rowHeader[rowIndex + 1 + i][cellIndex] = rowHeader[rowIndex + 1 + i][cellIndex] ?? [];
                rowHeader[rowIndex + 1 + i][cellIndex].push('^t');
              } else {
                rowHeader[rowIndex + 1 + i][cellIndex + 1] = rowHeader[rowIndex + 1 + i][cellIndex + 1] ?? [];
                rowHeader[rowIndex + 1 + i][cellIndex + 1].push('^t');
              }
            }
          }
          if (remainingCells >= 1) {
            rowText[rowIndex].push('T}:');
          } else {
            rowText[rowIndex].push(`T}${LF$1}`);
          }
          cellIndex++;
        }
        rowIndex++;
      }
    }

    let rowTextSlice = rowText;
    if (node.hasHeaderOption && rowText[0]) {
      result.push(`${LF$1}${rowHeader[0].join(' ')}.`);
      result.push(`${LF$1}${rowText[0].join('')}`);
      result.push('.T&');
      rowTextSlice = rowText.slice(1);
    }
    result.push(`${LF$1}${rowHeader[0].map(() => 'lt').join(' ')}.${LF$1}`);
    for (const row of rowTextSlice) result.push(row.join(''));
    result.push(`.TE${LF$1}.sp`);
    return result.join('')
  }

  async convert_thematic_break (_node) {
    return `.sp
.ce
\\l'\\n(.lu*25u/100u\\(ap'`
  }

  async convert_toc (_node) {
    // skip
  }

  async convert_ulist (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.title)}\n.br`);
    }
    for (const item of node.items) {
      const listText = this.manify(item.text, { whitespace: 'normalize' });
      result.push(`.sp
.RS 4
.ie n \\{\\
\\h'-04'\\(bu\\h'+03'\\c
.\\}
.el \\{\\
.  sp -1
.  IP \\(bu 2.3
.\\}${listText === '' ? '' : LF$1 + listText}`);
      if (item.hasBlocks()) {
        let itemContent = await item.content();
        if (listText === '' && itemContent.startsWith('.sp\n')) {
          itemContent = itemContent.slice(4);
        }
        result.push(itemContent);
      }
      result.push('.RE');
    }
    return result.join(LF$1)
  }

  async convert_verse (node) {
    const result = [];
    if (node.hasTitle()) {
      result.push(`.sp\n.B ${this.manify(node.title)}\n.br`);
    }
    let attributionLine = node.hasAttr('citetitle') ? `${node.attr('citetitle')} ` : null;
    if (node.hasAttr('attribution')) {
      attributionLine = `${attributionLine ?? ''}\\(em ${node.attr('attribution')}`;
    } else {
      attributionLine = null;
    }
    result.push(`.sp\n.nf\n${this.manify(await node.content(), { whitespace: 'preserve' })}\n.fi\n.br`);
    if (attributionLine) {
      result.push(`.in +.5i\n.ll -.5i\n${attributionLine}\n.in\n.ll`);
    }
    return result.join(LF$1)
  }

  async convert_video (node) {
    const startParam = node.hasAttr('start') ? `&start=${node.attr('start')}` : '';
    const endParam   = node.hasAttr('end')   ? `&end=${node.attr('end')}`     : '';
    const titleBlock = node.hasTitle() ? `.sp\n.B ${this.manify(node.title)}\n.br` : '.sp';
    return `${titleBlock}\n<${node.mediaUri(node.attr('target'))}${startParam}${endParam}> (video)`
  }

  async convert_inline_anchor (node) {
    const target = node.target;
    switch (node.type) {
      case 'link': {
        let macro;
        let resolvedTarget = target;
        if (target.startsWith('mailto:')) {
          macro = 'MTO';
          resolvedTarget = target.slice(7);
        } else {
          macro = 'URL';
        }
        let text = node.text;
        if (text === resolvedTarget) {
          text = '';
        } else {
          text = text.replace(/"/g, `${ESC_BS}(dq`);
        }
        if (macro === 'MTO') {
          resolvedTarget = resolvedTarget.replace('@', `${ESC_BS}(at`);
        }
        return `${ESC_BS}c${LF$1}${ESC_FS}${macro} "${resolvedTarget}" "${text}" `
      }
      case 'xref': {
        let text = node.text;
        if (!text) {
          const refs  = (this._refs ??= node.document.catalog.refs);
          const refid = node.attributes.refid;
          let top;
          const ref = refs[refid] ?? (!refid ? (top = this._getRootDocument(node)) : null);
          if (ref instanceof AbstractNode) {
            const resolvingSet = (this._resolvingXrefs ??= new Set());
            if (!resolvingSet.has(refid)) {
              resolvingSet.add(refid);
              const resolved = await ref.xreftext(node.attr('xrefstyle', null, true));
              resolvingSet.delete(refid);
              if (resolved) {
                text = resolved;
                if (ref.context === 'section' && ref.level < 2 && text === ref.title) {
                  text = this._uppercasePcdata(text);
                }
              } else {
                text = top ? '[^top]' : `[${refid}]`;
              }
            } else {
              text = top ? '[^top]' : `[${refid}]`;
            }
          } else {
            text = `[${refid}]`;
          }
        }
        return text
      }
      case 'ref':
      case 'bibref':
        // These are anchor points, which shouldn't be visible
        return ''
      default:
        this.logger.warn(`unknown anchor type: ${node.type}`);
        return null
    }
  }

  async convert_inline_break (node) {
    return `${node.text}${LF$1}${ESC_FS}br`
  }

  async convert_inline_button (node) {
    return `<${ESC_BS}fB>[${ESC_BS}0${node.text}${ESC_BS}0]</${ESC_BS}fP>`
  }

  async convert_inline_callout (node) {
    return `<${ESC_BS}fB>(${node.text})<${ESC_BS}fP>`
  }

  async convert_inline_footnote (node) {
    const index = node.attr('index');
    if (index) return `[${index}]`
    if (node.type === 'xref') return `[${node.text}]`
    return null
  }

  async convert_inline_image (node) {
    return node.hasAttr('link')
      ? `[${node.attr('alt')}] <${node.attr('link')}>`
      : `[${node.attr('alt')}]`
  }

  async convert_inline_indexterm (node) {
    return node.type === 'visible' ? node.text : ''
  }

  async convert_inline_kbd (node) {
    const keys = node.attr('keys');
    return `<${ESC_BS}f(CR>${keys.length === 1 ? keys[0] : keys.join(`${ESC_BS}0+${ESC_BS}0`)}</${ESC_BS}fP>`
  }

  async convert_inline_menu (node) {
    const caret    = `${ESC_BS}0${ESC_BS}(fc${ESC_BS}0`;
    const menu     = node.attr('menu');
    const submenus = node.attr('submenus');
    if (submenus && submenus.length > 0) {
      const submenuPath = submenus.map(item => `<${ESC_BS}fI>${item}</${ESC_BS}fP>`).join(caret);
      return `<${ESC_BS}fI>${menu}</${ESC_BS}fP>${caret}${submenuPath}${caret}<${ESC_BS}fI>${node.attr('menuitem')}</${ESC_BS}fP>`
    } else if (node.attr('menuitem')) {
      return `<${ESC_BS}fI>${menu}${caret}${node.attr('menuitem')}</${ESC_BS}fP>`
    } else {
      return `<${ESC_BS}fI>${menu}</${ESC_BS}fP>`
    }
  }

  // NOTE use fake XML elements to prevent creating artificial word boundaries
  async convert_inline_quoted (node) {
    switch (node.type) {
      case 'emphasis':
        return `<${ESC_BS}fI>${node.text}</${ESC_BS}fP>`
      case 'strong':
        return `<${ESC_BS}fB>${node.text}</${ESC_BS}fP>`
      case 'monospaced':
        return `<${ESC_BS}f(CR>${node.text}</${ESC_BS}fP>`
      case 'single':
        return `<${ESC_BS}(oq>${node.text}</${ESC_BS}(cq>`
      case 'double':
        return `<${ESC_BS}(lq>${node.text}</${ESC_BS}(rq>`
      default:
        return node.text
    }
  }

  // Class method: write stub man pages for alternate names
  static async writeAlternatePages (mannames, manvolnum, target) {
    if (!mannames || mannames.length <= 1) return
    mannames = mannames.slice(1);
    const manvolext = `.${manvolnum}`;
    const { dirname, basename, join } = await import('node:path');
    const { writeFile } = await import('node:fs/promises');
    const dir  = dirname(target);
    const base = basename(target);
    for (const manname of mannames) {
      await writeFile(join(dir, `${manname}${manvolext}`), `.so ${base}`);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  _appendFootnotes (result, node) {
    if (!node.hasFootnotes() || node.hasAttr('nofootnotes')) return
    result.push('.SH "NOTES"');
    for (const fn of node.footnotes) {
      result.push(`.IP [${fn.index}]`);
      // NOTE restore newline in escaped macro that gets removed by normalize_text in substitutor
      let text = fn.text;
      if (text.includes(`${ESC}\\c ${ESC}.`)) {
        text = this.manify(
          `${text.replace(MalformedEscapedMacroRx, `$1${LF$1}$2`)} `,
          { whitespace: 'normalize' }
        ).replace(/ $/, '');
      } else {
        text = this.manify(text, { whitespace: 'normalize' });
      }
      result.push(text);
    }
  }

  // Converts HTML entity references back to their original form, escapes
  // special man characters and strips trailing whitespace.
  //
  // It's crucial that text only ever pass through manify once.
  //
  // str  - the String to convert
  // opts - an Object of options to control processing (default: {})
  //        * whitespace: how to handle whitespace; supported values are:
  //          'preserve' - preserve spaces (only expanding tabs);
  //          'normalize' - normalize whitespace (remove spaces around newlines);
  //          'collapse' - collapse adjacent whitespace to a single space (default)
  //        * append_newline: Boolean; append a newline to the result (default: false)
  manify (str, opts = {}) {
    const whitespace = opts.whitespace ?? 'collapse';
    if (whitespace === 'preserve') {
      // expand tabs, then escape leading indentation (2+ spaces not at line start)
      str = str
        .replace(/\t/g, ET)
        .replace(/  +/g, (m, offset, str) => (offset === 0 || str[offset - 1] === '\n') ? m : `${ESC_BS}&${m}`);
    } else if (whitespace === 'normalize') {
      str = str.replace(WrappedIndentRx, LF$1);
    } else {
      // collapse: replace any run of whitespace chars with a single space
      str = str.replace(/[\n\t ]+/g, ' ');
    }

    str = str
      // literal backslash (not a troff escape sequence)
      .replace(LiteralBackslashRx, (m, $1) => $1 ? m : '\\(rs')
      // horizontal ellipsis (emulate appearance)
      .replace(EllipsisCharRefRx, '.\\|.\\|.')
      // leading . used in troff for macro call; replace with \&.
      .replace(LeadingPeriodRx, '\\&.')
      // drop orphaned \c escape lines, unescape troff macro, quote adjacent char, isolate macro line
      .replace(EscapedMacroRx, (_m, $1, $2, $3) => {
        const rest = $3.trimStart();
        return rest === '' ? `.${$1}"${$2}"` : `.${$1}"${$2.trimEnd()}"\n${rest}`
      })
      .replace(/-/g, '\\-')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#43;/g, '+')         // plus sign
      .replace(/&#160;/g, '\\~')      // non-breaking space
      .replace(/&#169;/g, '\\(co')    // copyright sign
      .replace(/&#174;/g, '\\(rg')    // registered sign
      .replace(/&#8482;/g, '\\(tm')   // trademark sign
      .replace(/&#176;/g, '\\(de')    // degree sign
      .replace(/&#8201;/g, ' ')       // thin space
      .replace(/&#8211;/g, '\\(en')   // en dash
      .replace(EmDashCharRefRx, '\\(em') // em dash
      .replace(/&#8216;/g, '\\(oq')   // left single quotation mark
      .replace(/&#8217;/g, '\\(cq')   // right single quotation mark
      .replace(/&#8220;/g, '\\(lq')   // left double quotation mark
      .replace(/&#8221;/g, '\\(rq')   // right double quotation mark
      .replace(/&#8592;/g, '\\(<-')   // leftwards arrow
      .replace(/&#8594;/g, '\\(->')   // rightwards arrow
      .replace(/&#8656;/g, '\\(lA')   // leftwards double arrow
      .replace(/&#8658;/g, '\\(rA')   // rightwards double arrow
      .replace(/&#8203;/g, '\\:')     // zero width space
      .replace(/&amp;/g, '&')         // literal ampersand (must come after other & replacements)
      .replace(/'/g, '\\*(Aq')        // apostrophe / neutral single quote
      .replace(MockMacroRx, '$1')     // remove mock boundary markers
      .replace(/\u001b\\/g, '\\')     // unescape troff backslash (ESC_BS → \)
      .replace(/\u001b\./g, '.')      // unescape full stop in troff commands (ESC_FS → .)
      .trimEnd();                      // strip trailing space

    return opts.append_newline ? `${str}${LF$1}` : str
  }

  _uppercasePcdata (string) {
    if (!XMLMarkupRx.test(string)) return string.toUpperCase()
    // Reset lastIndex since XMLMarkupRx is stateless (no /g flag) but test() advances for sticky
    return string.replace(PCDATAFilterRx, (_m, $1, $2) => $2 ? $2.toUpperCase() : $1)
  }

  async _encloseContent (node) {
    return node.contentModel === 'compound'
      ? await node.content()
      : `.sp\n${this.manify(await node.content(), { whitespace: 'normalize' })}`
  }

  _getRootDocument (node) {
    while ((node = node.document).isNested()) {
      node = node.parentDocument;
    }
    return node
  }
}

ManPageConverter.registerFor('manpage');

const manpage = /*#__PURE__*/Object.freeze({
  __proto__: null,
  default: ManPageConverter
});

export { Extensions, SyntaxHighlighterBase, browser as default };
