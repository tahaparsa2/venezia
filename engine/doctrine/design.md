# Design standard

The gate proves a page runs. It cannot see whether the page is good. Every prototype this factory ships carries its name, so a page that merely works has not met this standard. A person should look at the first screen and think someone cared.

## Start with a point of view

Before any CSS, decide what this thing should feel like, drawn from the idea itself. A tide table might feel like a printed almanac, a timer like a kitchen instrument, a budget tool like a calm ledger. Write that down in one sentence and let it pick the type, the colour and the layout. If the design would suit any other app, it has no point of view.

## Do not ship the default look

These are the marks of a generated page. Avoid all of them unless the idea truly calls for one:

- A purple or blue gradient, on a hero or on buttons
- A centred card floating on a grey or gradient page
- Every section in a rounded box with a soft shadow
- Inter or Arial with no thought behind it, one weight, one size
- Emoji standing in for icons
- A headline that restates the app's name, or copy like "Welcome to" and "Get started"
- Decoration that means nothing: blobs, glassmorphism, sparkles

## Craft

- **Type:** one characterful choice used well, on a clear scale of three or four sizes with real contrast between them. A native system stack is fine when set with care, and that includes the serif and monospace stacks. Keep body text at 16 px or above and lines under about 70 characters. Use `font-variant-numeric: tabular-nums` where numbers line up.
- **Colour:** define tokens in `:root`. Pick a real neutral, tinted to suit the idea, and one or two accents with a job to do. Text contrast meets WCAG AA. Colour never carries meaning alone.
- **Dark mode:** respect `prefers-color-scheme` with properly chosen colours, unless the idea has one true mode.
- **Space:** use one spacing scale. Let related things sit close and unrelated things sit apart. Whitespace is how you show structure, and boxes are a last resort.
- **Hierarchy:** on every screen one thing is clearly first. Primary action obvious, secondary actions quiet.
- **Layout:** design for 390 px first, then make real use of 1440 px. A desktop page that is a stretched phone column has wasted the screen.
- **Motion:** small, quick and purposeful, 120 to 240 ms, on `transform` and `opacity`. Honour `prefers-reduced-motion`.
- **Icons:** inline SVG, one consistent set. Give the page a real `<title>` and an inline SVG favicon.

## Every state is designed

Check each one, since these are where generated apps fall apart:

- **Empty:** the first thing a new user sees. It explains what to do next, in the voice of the app. Never a blank panel. Remember that every gate run starts here.
- **Loading:** only if something truly takes time. No fake spinners.
- **Error:** says what happened and what to do, in plain words.
- **Full:** long text, many items, big numbers. Nothing breaks, nothing overflows.
- **Interactive:** visible hover, active, focus and disabled styles. A keyboard user can see where they are.

## Words

Write like a person who cares about the reader. Real labels, real example content, a sentence of voice where it helps. No lorem ipsum, no "Item 1", no placeholder names. Buttons say what they do.

## Touch and access

Tap targets are at least 44 px. Every control has a label. Use real `<button>`, `<a>`, `<label>` and `<input>` elements. Nothing depends on hover alone. It works one-handed on a phone.

## The test

Picture your own page at 390 px and 1440 px and ask: would someone screenshot this because it looks good, or only because it works? If only the second, it is not finished.

You cannot open a browser here. Chrome does not start inside your sandbox, so do not try, and do not work around the refusal. Read the CSS at those two widths instead. The host's gate takes real phone and desktop screenshots afterwards, and the reviewer judges them.
