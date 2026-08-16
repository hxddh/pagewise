# Changelog

All notable changes to PageWise are documented here. Version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [9.1.0] - 2026-08-16

### Fixed

- **Everything PageWise told the assistant about your current situation was being thrown away.** Which document is open, how many pages it has, which page you are looking at, and the instructions for a whole-document question — all of it was assembled correctly on every question and then discarded before the request was sent, because it was attached to a field the assistant framework no longer uses. It has been silently doing this for as long as the code has existed. Asking about "this page" was working by luck, from the wording of your question alone.

### Added

- **What was established earlier now comes into the next question.** The findings the assistant recorded in 9.0 are sent with your next question, so it does not have to read the same pages again to work out what it already knew. Claims you struck out, and ones the assistant itself corrected, are never sent.

### Notes

- The record is capped at about 2,000 characters per question — roughly a third of what reading one page costs, which is the trade this exists to make. When there is more, the most recent entries are kept and the question says how many were left out.
- It is attached to your question rather than to the assistant's standing instructions, deliberately. The instructions are what providers cache first, and a record that grew each turn would throw that cache away on every question — turning the saving into a permanent loss.
- The record does not stop the assistant reading. It says what is already known and asks it not to re-read pages purely to re-derive that; the pages are still one step away when a question actually needs the text.
- The discarded-context bug was found by dumping the request the provider actually receives. The function that builds the hint had eight passing tests and all of them were right — it was the name of the field the result was assigned to that was wrong, one layer above where those tests stop. That field name is now pinned by a test of its own.

## [9.0.0] - 2026-08-16

### Added

- **The assistant can write down what it worked out.** Until now all six of its tools only read, so every question started from nothing: it would read page 12, answer, and read page 12 again from scratch six questions later. It can now record a finding — a claim, and the pages it came from — and correct one when later reading contradicts it. The old wording is kept beside the correction, with the reason.
- **One record for the document, written by both of you.** Your marks and the assistant's findings now appear in a single list under the same tab, in page order. They are never the same colour and each finding says whose it is in words: what came off the page and what was worked out about it must stay tellable apart.
- **Every finding shows the pages it came from, and you can strike one out.** A struck finding stays on screen so you can undo it, and is never told to the assistant again. A claim with no pages is refused outright rather than stored.

### Notes

- This is the first half of a change described in `docs/reviews/2026-08-15-pagewise-v9.0-design.md`. The record is written and shown here; **9.1** is where it starts replacing re-read pages in what the assistant is sent, which is where the saving is.
- **It costs something now and saves later.** Two new tools add about 203 tokens to the description block sent with every question — a byte-proportional estimate against the 736 previously measured, not a token count, because there is no way to measure tokens properly here. That cost is paid on every question from today; the saving arrives in 9.1 and only for documents whose pages get revisited. Both tool descriptions are deliberately the shortest in the set for this reason.
- The findings live in their own file rather than joining `marks.json`. Adding them there would have meant changing that file's version, and the mark loader discards data whose version it does not recognise — every existing reader's marks would have been thrown away on first launch.
- A finding is anchored to page numbers, not to a rectangle like a mark. The assistant reads page text and has no coordinates; pinning a claim to a rectangle it never chose would be an invented anchor, which is worse than a coarse honest one.
- Findings written before the file changed are kept and flagged rather than discarded, exactly as marks are.

## [8.1.8] - 2026-08-15

### Fixed

- **Page references in answers were not clickable, and never had been.** When the assistant wrote "see page 2", that was meant to be a link that jumps the preview to page 2. It was being rendered as plain text instead: the markdown renderer's link sanitiser does not recognise PageWise's own internal link scheme and blanked it out, so every citation in every answer lost its destination on the way to the screen. They work now.
- **The document outline was flat below the second heading level.** Sub-sections indented once and then stopped, so a sub-sub-section sat at exactly the same place as a chapter title and the outline showed nothing about how the document nests — which is the one thing an outline is for. Each level now steps in, up to five deep, after which the indent would cost more in title than it gives back in structure.

### Notes

- Nothing failed loudly in either case. The page-reference machinery has its own tests and they all passed: they check the step that finds the reference, which was always correct, and the loss happened one layer below them. It took opening a real conversation and counting the links on screen — zero, where there should have been sixteen.
- The outline's indentation was a single style rule covering level 2 and nothing beyond it. It has been replaced by one that follows the level itself, so a document nested deeper than its author expected still reads correctly.
- Also looked at and found sound: the marks list with real marks in it, at both window sizes; and a four-turn conversation with tool steps, streamed prose and the pages-read trail.

## [8.1.7] - 2026-08-15

### Fixed

- **A wide assistant panel could push two of the toolbar's buttons off the document and under the panel itself.** The panel can be dragged between 360 and 480 pixels, and that ceiling took no account of the window it was in. In the smallest window PageWise allows, a 480-pixel panel leaves the toolbar 199 pixels for 302 pixels of controls, so "Mark a region" and the zoom control were drawn past its edge, behind the assistant's own header, where neither could be clicked. How wide the panel may be now depends on the window, and it is re-checked when the window is resized.

### Notes

- This is not only a drag away. The panel's width is remembered, so sizing it on a large display and later opening a small window brought the same layout back — that restore is the case the limit mostly exists for.
- The limit only applies where it must: from a 1100-pixel window upward the full 480 is still available, unchanged. Checked at 900, 1000, 1100, 1200 and 1440 with the page thumbnails open, which is the tightest the document side ever gets.
- The panel now also reports the width it will actually accept to screen readers, rather than always claiming 480.

## [8.1.6] - 2026-08-15

### Fixed

- **In a small window, the buttons above the page drew on top of each other.** The page number and its arrows are centred in that bar, and they were centred by being lifted out of the layout — so the bar arranged the filename and the tool buttons as though they were not there. At a wide window nothing showed. At the smallest window PageWise allows, the middle group covered both neighbours, and clicking "Mark a region" or the thumbnails button pressed a page arrow instead. Neither could be reached at all.
- **The third tab above the page thumbnails was still being cut off.** 8.1.4 and 8.1.5 shipped with it: widening the sidebar in 8.1.3 gave the room to the sidebar, but the tab strip shares its row with another control and never received it. The strip had 119 pixels for 124 of tabs, at every window size — which is why making the window bigger never showed it either.
- **The filename no longer shows as a single stray letter.** At the narrowest window with the page thumbnails open there is no room for it, and what was drawn was the first character of the name — which reads as a fault rather than as truncation. It is now left out, and only in that one case.

### Changed

- **The page sidebar no longer has its own close arrow.** The button beside the toolbar's page-number controls already opens and closes that panel, is present whenever the panel can exist, and is the only one of the two that can bring it back. Removing the duplicate is what gave the tab strip its room; widening the sidebar instead was measured and would have pushed the toolbar back into the overlap fixed above.

### Notes

- All three were found at 900×600 — the smallest window this app permits, and a size nothing had ever been looked at in. Every screenshot before this release was taken at 1440×900.
- The first repair for the toolbar was wrong in an instructive way: it centred the middle group correctly and squeezed the right-hand column to 78 pixels for 168 pixels of buttons, which pushed the same two buttons out the other side. Same defect, one layer deeper.
- 8.1.3's check has been corrected rather than removed. It asserted a width on the sidebar, and passed for two releases while the tab it was written for was still cut off — a proxy for the thing that matters is not the thing that matters.

## [8.1.5] - 2026-08-15

### Fixed

- **A document that would not open said so twice, and the second copy blocked the first.** The failure was reported both as a banner across the top of the window and as a toast in the same corner, four pixels apart — and the toast's close button landed exactly on the banner's Dismiss, so the banner could not be closed until the toast expired on its own. The banner stays; a document that would not open is a state you are left in, not an event that went past.
- **Every row in the Library repeated the filename it had just printed.** The second line showed when the file was opened and where it came from, but "where it came from" ended with the file's own name — so an ordinary paper wrapped onto two lines and a long export onto three, and none of that height carried anything new. The line now says the folder.
- **The AI Provider panel could report a bad key and call the connection verified at the same time.** A green "In use · verified" badge sat directly above a red "Invalid API key" banner. The badge now says "Connection failed" while that error is on screen.

### Notes

- All three were found by photographing the app rather than reading it — the error screens and the Library drawer were the last surfaces the screenshot harness had never opened. Each is held by a test in the normal suite, and each of those tests was checked to fail when its fix is reverted.
- The connection panel's failure is still reported twice, once in the panel and once as a toast, and that is deliberate: its banner sits inside a scrolling panel, so a reader who scrolled down to reach the Test connection button could otherwise get no answer at all. The load failure's banner is fixed to the window and has no such problem.
- A failed connection test does not un-verify the provider. That flag gates the assistant, and a single dropped request should not lock a reader out of chat.

## [8.1.4] - 2026-08-15

### Fixed

- **Page numbers under the thumbnails were covered by the thumbnail below them.** Only the last page's number was ever visible. They were all there, in the right colour — each one was simply drawn past the bottom of its own row, where the next row starts.
- **The thumbnails are bigger.** The row they sit in was too short for a portrait page, which is what caused the numbers to spill; sizing it properly gives the page itself more room, which is the whole point of a thumbnail.
- **Scrolling a long document's thumbnails no longer drifts.** The list only draws the rows near the window and works out where they go by measuring one row — but it measured the button without the space beneath it, so the arithmetic was eight pixels short per row and further out the further you scrolled.

### Notes

- A page wider than portrait now shrinks to fit its row rather than making every row taller, keeping its proportions as it does. A row height that changes with the page and a list that measures every row the same cannot both be right, and the list's arithmetic depends on the measurement.
- The first fix tried here made the numbers visible by shrinking the page instead — correct by every number, and visibly worse: the thumbnail became a sliver. It was thrown away rather than shipped. Screenshots are the only reason that was noticed.

## [8.1.3] - 2026-08-15

### Fixed

- **The third tab above the page thumbnails was cut off mid-word.** "Pages", "Outline" and "Marks" needed more room than the sidebar gave them, so "Marks" ran past the edge and read as "Mar". The sidebar is a little wider now.

### Notes

- Narrowing the tabs instead recovered only part of the gap, and their type is already at the bottom of the scale — which is a floor in a tool meant for reading, not a size to go below. Letting the strip wrap onto a second line would have looked like a mistake. So the sidebar got the width; the thumbnails in it are unaffected.
- The width is set above the point where the labels merely fit. The measurement comes from the screenshot harness, which runs a different browser engine from the ones the app ships in, and type is exactly the thing that differs between them.

## [8.1.2] - 2026-08-15

### Changed

- **The screenshot script can now reach the page/outline/marks sidebar.** It could not before, for a reason that took a while to see: that sidebar is deliberately hidden for a document with only one page, and the only sample file the script had was one page long. So the control genuinely did not exist to open, and its absence looked for a moment like a missing button. A three-page sample file was written for the purpose.

### Notes

- With the sidebar finally on screen, its tab strip turns out to be wider than the sidebar itself — "Marks", the third tab, runs 49 pixels past the edge and is cut off mid-word. Measured, not eyeballed. It is not fixed here; this release is the part that makes it visible, and the fix wants a round with room to check it.

## [8.1.1] - 2026-08-15

### Changed

- **The screenshot script now also photographs in-document search**, the surface whose results were being drawn off the bottom of the window until the previous release. A check that never opens the screen it was written for is a check in name only.

### Notes

- An automatic detector for that whole class of fault — content that exists, is styled correctly, and is drawn where nobody can see it — was written this round and **not shipped**. It failed to catch the bug it was written for, three times, for three different reasons; the last version could scroll an unrelated pane until the lost content came into view and then called it reachable. A check that reports "all clean" is worth nothing until it has been shown to fail on a real instance, and this one never did.

## [8.1.0] - 2026-08-15

### Fixed

- **Searching inside a document showed you nothing.** It found the matches — the count, the page numbers, the surrounding text were all built correctly — and then drew them just past the bottom edge of the window, where you could not see them. The panel had also grown to the full height of the window, so the frosted surface it sits on covered the document you were searching.
- **The close button in that panel sat on a line of its own**, a bare ✕ under the search box, instead of beside it.

### Notes

- One default did all of that: the panel is laid out as a flex item and nothing said how tall it should be, so it took the whole window. The results are positioned relative to it, which put them 858 pixels below the top of the screen.
- Nothing was broken enough to fail a test. Every element existed, with the right text and normal contrast — the only thing wrong was where it landed, which is why this survived until the app could be photographed. The second one was invisible even then, until the first was fixed.

## [8.0.4] - 2026-08-15

### Changed

- **The library that stores your API key in the system keychain, 3 → 4.** Where the key lives and how it is read are unchanged: macOS Keychain, Windows Credential Manager, Secret Service on Linux.

### Notes

- Version 4 is a different library wearing the same name; what is used here is its compatibility layer, which keeps the previous interface exactly. Its authors suggest applications eventually move to the new one directly, which is a larger change and not this one.
- On Linux the underlying Secret Service client changed. It talks to the same keychain, and these calls already run off the main thread, so nothing about the app's behaviour depends on which one it is.
- On a machine with no keychain at all, the message the library produces changed wording. Nothing in the app reads that text — a keychain failure of any kind already falls back to the local store — but a test did, and it had to be taught the new phrasing.

## [8.0.3] - 2026-08-15

### Added

- **A check that no debugging output reaches the shipped app.** It runs after every build. Console messages were already being removed, but only because a setting said so, and settings stop being true quietly — this one had, in a way nobody would have noticed until it was in someone's browser console.

### Changed

- **Vite 7 → 8, and the React plugin 4 → 6.** Building the app went from about eight seconds to under two — roughly four times faster, measured three runs each way. What ships is the same code; only the tools that assemble it changed.

### Notes

- These were meant to be two separate releases, one upgrade each, so that anything that broke could be blamed on one thing. They could not be separated: the older React plugin refuses to install alongside the newer Vite, so the halfway state does not exist. The rule gave way to the fact.
- The new bundler accepts only one of the two ways of describing how the app is split into files, so that description was rewritten in the other form. Checked rather than assumed: the same pieces, total within three kilobytes of before.

## [8.0.2] - 2026-08-15

### Changed

- **TypeScript 5.8 → 7.** Checking the whole codebase for type errors went from about 6.9 seconds to about 1.6 — a little over four times faster, measured three runs each way on the same machine. Nothing in the app changed and nothing needed changing: the new compiler reported zero errors on the existing source, first try.

### Notes

- The compiler only checks types here; the bundler does the actual translation and never consults it (`noEmit` is set). So a compiler change cannot alter what ships, which is why this is a patch release despite being a major version of the toolchain.

## [8.0.1] - 2026-08-14

### Changed

- **The screenshot harness now covers the screen you actually spend time in** — a question, the assistant reading a page, the answer streaming in, the pages-read footer. The provider is faked at the network edge rather than inside the app, so the tool loop, the streaming text and the citation rendering are all the real code. Nothing about the app changed; this is what makes the next round of interface work possible to check.
- The harness's fake document now matches the file it opens. It claimed three pages for a one-page fixture, which made the preview report "Invalid page request" — the app telling the truth about a lie it had been told, and the second time the harness invented a defect that was not there.

### Notes

- Looking at the answering screen this way turned up nothing to fix. Two things that looked wrong were the harness's own fault, and a third — the faint action icons under each answer — is deliberate: they sit at half strength and come up to full on hover. Recorded because a round that finds nothing is worth the same as one that finds something, provided it actually looked.

## [8.0.0] - 2026-08-12

### Added

- **The app can be looked at.** Until now every review of how PageWise looks was done by reading its code — the one that tried to open it in a browser got a blank page and said so in its first paragraph. That is why "the interface is rough" kept being raised and never resolved: nobody could see it. `npm run ui:shots` now opens the real app in a browser against a faked desktop shell and photographs the screens you actually use. It touches no application code and ships nothing.

### Fixed

- **The welcome screen said the product's name twice**, one line under the other, in both languages — the title already contains it. Visible in a screenshot in a second; invisible in the code, which is where everyone had been looking.
- **Two buttons for one action.** With a document open and no AI configured, the top of the chat panel offered a "Configure in Settings" link while the bottom offered a "Configure AI" button. The explanation stays; the duplicate control is gone. Where there is no document — and so no button at the bottom — the link remains, because there it is the only way through.
- **Links stopped looking like unstyled web pages.** The inline links on the welcome and empty screens were permanently underlined, which on a dark interface reads as a page nobody styled. They underline on hover and on keyboard focus now.

### Changed

- **Depth and motion are on a scale, like spacing and type already were.** Twelve drop shadows had been written out by hand across eleven different values, while the one shadow that had a name was used once in the whole app; two animations had been given two different speeds each, so the same kind of popover opened at two rates depending on which one you opened. Both are now three steps, both follow the light and dark themes on their own — which deleted three rules that existed only to restate a shadow for the light theme — and a new value off the scale fails the build unless it says why.

### Notes

- The browser the harness uses is not the one the app ships in, so it settles layout, wording, empty space and duplication — not pixels, colour or font metrics. Every defect above is in the first category. It is also not a screenshot-comparison gate: pixel baselines across machines are flaky enough to get waved through, and a check that gets waved through is worse than none. What holds these fixes is ordinary tests asserting what is on screen.
- The first thing the new depth-and-motion check did was find two animations the search that motivated it had missed, because their names had capital letters in them.

## [7.8.0] - 2026-08-11

### Fixed

- **A model that stopped answering used to leave the app waiting forever.** If a provider accepted the connection and then went quiet — a dropped socket, a wrong base URL, a proxy that never replies — the answer stayed mid-stream with no end and no error. Nothing told you it had died, because from the outside a hung connection and a model thinking hard look the same. There are now deadlines: ninety seconds to start answering, forty-five between one piece of the answer and the next, and thirty seconds for the two "Test connection" buttons in Settings, which previously could spin until you gave up on them.

### Changed

- **The tool descriptions that make up the cached part of every request are now held in place by a test.** They are the first thing sent and the first thing a provider caches, so editing a word of one — a normal, harmless-looking change — quietly costs everyone with a warm cache a full re-read of it on their next question. Nothing said so anywhere. A change to any of the six now fails the build and says what moved, so it becomes a decision rather than an accident.
- Kept current with the SDK and the PDF library: `ai`, the React and OpenAI adapters, the icon set, and the Rust side including the PDF parser.

### Notes

- The deadlines above are set to catch a connection that is dead, not one that is slow, because firing early is the worse mistake: it kills a run that was working and you pay for the whole context again on the retry. The first draft had a ceiling on a whole run that was lower than the longest run the app itself permits — a test comparing the two numbers is what caught it, not the arithmetic that produced them.
- Two of the vision paths already had deadlines and did not need these. It was the paths nobody had thought about that had none, which is the usual shape of this.

## [7.7.0] - 2026-08-09

### Fixed

- **A document's "send the page screenshot" and "use web search" choices could outlive the document.** They are remembered so that retrying a question re-runs it the same way, and they were cleared on the one path that closes a document — which held only because every caller remembered to call it. Any other route to a new conversation carried the previous document's choices into it. Clearing is now part of the conversation changing, not of the caller being careful.

### Changed

- **The parts of the app that hold every message, and every API key, now have tests.** The hook every question passes through — send, edit, retry, mid-run correction, the optimistic message and its removal on failure — had none, and neither did the settings panel. Between them that is 1,400 lines of the app's most stateful code. Fourteen tests now hold the hook's promises and six hold the settings panel's, and each was checked by breaking the thing it guards and confirming it fails.
- **Every hand-written `<button>` in the app now says why it is not the shared one.** A release two versions ago replaced twenty-one button styles with a single component and argued that a handful of elements should stay as they were — a card is not a control, a tab is not a button, a link inside a sentence has no box around it. That argument was right and was written down once, about a set nobody listed, so nothing could tell an argued exception from something no one had got to. All 33 are now labelled with the reason, and a new one without a reason fails the build.
- The key-fingerprinting used to notice when you change an API key is now tested directly, including that neither the fingerprint nor the snapshot it goes into ever contains the key.

### Notes

- The evaluation for this release said the settings layer was thinly tested, counting it as one 2,000-line block. Its logic half was not: `settings.ts` had 38 tests covering migration, keychain fallback and the store's edges, and `llm.ts` had 12. The untested half was the interface, and the thinnest layer in the app was somewhere else entirely — the hooks. The same evaluation also listed a file that does not exist; the check behind it looked for a test and never asked whether there was anything to test.
- One thing 7.6 shipped is still unverified against a real provider: a correction typed mid-answer is delivered as a message appended after the last tool result, and that shape has only ever been checked in unit tests. Interrupting an answer once will settle it — the fallback to the old behaviour is already there if a provider objects.

## [7.6.0] - 2026-08-08

### Added

- **A correction typed while the agent is working now reaches the run that is working.** Sending mid-run already redirected the answer, but it did so by stopping the run and starting another — and every page the first run had read went back into a fresh context and was billed again. The note is now handed to the loop as a message its next step reads, so nothing is stopped and nothing is re-read. It also lands on the question you asked, so the transcript records what you said and why the answer changed; a correction that arrives after the run has finished comes back to the composer instead of disappearing.

### Changed

- **The 3,590-line stylesheet is now thirteen numbered parts.** It had two section comments in it, and rules near the end existed only to override rules a thousand lines earlier, so which declaration applied was decided by source order. The parts are cut to preserve that order exactly — building before and after produces a byte-identical stylesheet — and a check fails if the order ever drifts, because moving a part changes what the app looks like.
- **116 rules and four animations with nothing behind them are gone**, left over from the v3 shell replacing the sidebar, the recent-files list and the onboarding steps. The stylesheet the app downloads is 17% smaller. The tool that finds them was wrong in both directions before this — it called a rule live because a source file happened to be *named* after it, and called pdf.js's own class dead — so the count it reported could not be trusted; it reads markup now.
- Unreachable rules, orphaned animations, a reordered cascade and a value a design token already names each fail the test suite now, rather than being tidied by hand every few releases and growing back.

### Fixed

- **The drop overlay and the loading overlay stayed near-black in light theme.** Both had the dark theme's background colour written out as a literal, so dropping a file or opening a document in light mode covered the window in a scrim that matched nothing on screen.
- **A highlight and its own border could disagree.** The highlighter yellow was written out four times with four different blend amounts; it is one colour with a name now.

### Notes

- The evaluation for this release reported "95 hardcoded sizes" in the stylesheet. The real number was **one**. The measurement counted `margin: 0`, `border-radius: 50%`, values already using tokens, and every text-relative size in the Markdown styles — so the conclusion drawn from it, that the type and spacing scale were only locally observed, was wrong. Coverage was already near complete. The corrected measurement is a script in the repository, and it documents why the old number was off by about ninety-five to one.
- Two items the evaluation listed as measurements were not done: both need a real model call against a real document, which this repository cannot make on its own. What *is* established is that nothing in the app has ever asked a provider to cache anything explicitly, so on any route that requires an explicit request, prompt caching is off rather than merely missing. Deciding whether that matters takes one long conversation and a glance at the usage panel.

## [7.5.6] - 2026-08-08

### Fixed

- **Asking about a page, with follow-agent on, did not go to that page.** Naming a page in your question switched following off entirely instead of narrowing it to the page you named — so "第5页讲了什么" had the assistant read page 5 while the preview stayed parked wherever it was. The guard exists so the preview does not wander to pages you did not ask about, and it still does that; it now lets through the one page it was most clearly meant to allow. A named range follows anywhere inside it. A question that is about the whole document still keeps the preview still.

## [7.5.5] - 2026-08-07

### Fixed

- **Long conversations got more expensive at the point they were supposed to get cheaper.** Past twelve exchanges, the older ones are folded into a single note so the conversation stops growing. That note goes at the very front of what is sent — inside the part every provider caches — and it named the number of folded exchanges and quoted them, so its text changed on every single turn from the thirteenth onwards. A changed first line means nothing after it can be read from the cache, so each question re-bought all twelve kept exchanges at full price, which is something the unwindowed conversation it replaced never did. The fold now moves in steps of four turns instead of one, so the front of the prompt stays identical between moves and one turn in four pays for the change rather than every turn.
- **The note that replaced the old exchanges grew as fast as they did.** It quoted every folded question, up to 60 characters each — several thousand characters a hundred turns in, in a line whose entire purpose is to be smaller than what it replaces. It now quotes the six most recent and counts the rest, so it stays about the same size whether it stands in for ten exchanges or two hundred.

## [7.5.4] - 2026-08-07

### Fixed

- **Re-indexing threw away paid-for pages it was never going to re-scan.** A re-index rescans a bounded window — 50 pages by default — precisely so the text it discards is text it will pay to replace. But alongside that it deleted the saved index for the *whole* document. The pages outside the window keep their text for the rest of the session, so nothing looks wrong; they simply have nothing left on disk, and get scanned and billed again the next time you open the file. On a 200-page scan you had already indexed, changing your vision model quietly discarded 150 pages of work you had paid for. Only the pages actually being re-scanned are forgotten now.
- **The re-index message named a number that was not true.** It always said "up to 50 pages", whatever the page-scanning budget was set to — and said it even when the budget was zero and nothing was being re-scanned at all. It now reports the real count, and says plainly when there is nothing to do.

## [7.5.3] - 2026-08-07

### Fixed

- **Looking at a figure painted the whole page at up to four times the pixels it meant to.** Rendering a crop hands pdf.js a scale, and pdf.js multiplies that scale by the display's pixel ratio — so a caller wanting a specific pixel count has to divide the ratio back out. Sending a *page* to the vision model has done that since 3.4.0. Sending a *figure*, written later, never did: on a retina display the crop came out at twice its intended long edge, and the 4096px ceiling that stops a small figure from demanding an enormous page render was quietly 8192px. That ceiling is the limit that binds most of the time — on a letter page any figure under about 300pt is capped by it — so the usual outcome was a page painted at four times the area to cut one figure out of, around 350MB of canvas for a 24pt logo, and a JPEG several times larger than the vision provider will even keep. Both limits are now honoured whatever display you are on.

## [7.5.2] - 2026-08-07

### Fixed

- **Changing your vision model billed a scan for every text page in the document.** Switching it re-indexes, and re-indexing cleared the text of every page it was given — which is every page, including the ones whose words came out of the PDF's own text layer. That text is free and re-extracted on each open; wiping it made those pages look unindexed, and a page with no usable text is exactly what gets sent to vision. On a two-hundred-page text document, changing one setting meant paying to look at pages that were never scanned in the first place. Only vision-produced text is cleared now, so the pages that had a text layer keep it and the indexer skips them before it reaches a billed call.

## [7.5.1] - 2026-08-07

### Fixed

- **The page you scrolled to could render after the pages you scrolled past.** A high-priority render was inserted ahead of the first background item in the queue — which puts it *behind* every high-priority render already waiting — unless the queue happened to contain no background work at all, in which case it went to the front instead. Two orderings for the same request, chosen by something unrelated to it, and the slower one is the ordinary case: thumbnails are queued whenever the sidebar is open. The newest visible page now goes first either way.
- **A document with a pipe in its filename re-rendered every page, every scroll.** The preview cache keys a bitmap as `path|page|scale|quality|dpr` and read it back by splitting on the separator from the left — so a pipe inside the path shifted every field along and no lookup ever matched, while the bitmaps sat in the cache untouched. It reads from the right now: the four trailing fields have a known shape, the path does not. (A pipe is a legal filename character on Linux and macOS.)

## [7.5.0] - 2026-08-07

### Fixed

- **A page that was not re-sent still re-sent its marks and links.** 7.3 stopped the same page's text being handed over twice in a turn; the attachments beside that text never learned about it. The range reader gathered marks and links across everything it was asked for, not what it actually returned, so a repeat read came back as eleven one-line markers followed by every mark on all eleven pages. Attachments now belong to the pages a result carried.
- **A marked passage was sent twice in the same result.** A mark's text is, by its own definition, words from the page being read — and on this path it was carried whole, up to 500 characters of it, next to the page text it came from. The document survey had worked this out long ago and kept a 120-character snippet; the read path never got the same treatment. It does now. Your own note is never truncated: unlike the passage, it exists nowhere else.

### Changed

- **One file per tool.** 7.4 moved the six document tools out of the agent file and into a single 1,106-line one, which shrank the agent and left the pile intact. The reason that mattered rather than merely looked untidy is the bug above: the two readers sat two hundred lines apart and disagreed about what a page ships. The reading layer they share is now one module, attachment assembly is another that both call, and each tool is its own file of 73–168 lines.
- **Conversation search and keyboard navigation moved out of the chat panel** into one hook and a small component — they always shared a focus mechanism. The panel had grown to 839 lines and become the largest component in the app, because two consecutive releases each had a good reason not to split it while adding something to it.
- **Dependencies brought up to date** — four patch releases including the AI SDK. TypeScript 7, Vite 8 and the React plugin remain their own rounds.

### Notes

- Conversation branching will not be built. It was deferred four rounds running, which is a decision nobody had stated, so: in a document reader the need to keep an old answer and start a second branch is far weaker than in a coding agent, and the cost is turning a conversation from a chain into a tree along with its migration and its UI. Editing and resending covers the case that actually comes up — the previous question was aimed wrong. It will not appear in future reviews.

## [7.4.0] - 2026-08-06

### Fixed

- **Three settings controls had no accessible name.** The API key box and both model pickers were a `<span>` of label text next to a control, with nothing connecting them — a screen reader announced the model picker as "gpt-4o", with no indication of what it selects. The primitive that fixes this was added two releases ago and then used nowhere; its own comment said it existed because "some had `htmlFor` and some did not", and that stayed true because nothing adopted it. Every field in the app now goes through it, including the one whose markup was moved in 7.3 with the defect intact.
- **The document survey sent about 1,273 tokens of numbers nothing could act on.** Every call returned the character count of all 200 pages. What planning needs was already in the same result — the document's total length, whether it needs chunking, and which pages are unreadable, or carry figures, tables, links or your marks — and the readers handle chunking themselves. What replaces it is the handful of densest pages, which at least points somewhere; the full list is still one flag away.
- **Five standing notes were resent with every tool result.** 7.2 moved one of them into the system prompt and left the rest: a ten-page read over pages with links and marks repeated the same two sentences ten times. They are now stated once, where they are sent once and land inside the cached prefix. The two notes that remain in results are the ones that genuinely vary — a quota reached, a page that changed under a read.

### Added

- **Search inside the conversation.** The find chord, while the assistant panel has focus, searches what you can actually see — not folded reasoning or tool machinery, which would send you to a turn where the word is nowhere on screen. Enter and Shift+Enter cycle the hits and wrap; the conversation walk added in 7.3 deliberately does not wrap, because stepping through hits is a loop you are cycling and walking a conversation is not.

### Changed

- **The agent file is 274 lines instead of 1,347.** The six tools and the reading layer they share moved to their own module, leaving the prompt and the loop configuration behind. That file was the largest in the repo and the one you had to open to change either how a tool reads or how the loop runs — and 7.3's duplicate-read bug happened inside it, between two readers two hundred lines apart.
- **Tool results have a declared shape.** There was none: six tools assembled objects at thirty-one separate return sites, with nineteen kinds of field on one and one on another. Both problems fixed above lived in that gap, because nothing showed in one place what the tools actually put into the context. The type says that standing instructions do not belong in a result — which is the mistake it exists to make visible.
- **Six more buttons went through the button primitive**, and the ones that should not are now written down beside it: backdrops have no chrome by design, menu rows are styled by the popover they sit in, and a page thumbnail or a recent-file card is content you click rather than a button.

### Notes

- Withdrawn from two earlier reviews: `resumeStream` does not apply to this product. It resumes a server-side stream after a client reconnect, and the agent runs in the renderer with no server and no stream store; the reload case was already handled. It was listed as an unused capability twice without anyone asking whether it fits this architecture.
- A comment justifying the survey's preview flag claimed 200 previews cost about 40,000 characters and ten thousand tokens. Measured, it is 19,693 characters and about 4,900. The number is corrected in place — a figure used to argue for a design should be one that was measured.
- Branching a conversation is deferred a third time. It is the only outstanding item that changes the shape of the stored conversation, from a chain to a tree, and it should not ride along with anything else.

## [7.3.0] - 2026-08-06

### Fixed

- **7.2's "the same page is never bought twice" was not true of the tool that reads pages.** The ledger of pages already handed over lived entirely inside the range reader, so `read_pdf_page` — the most-called of the six tools — neither consulted nor updated it. Of the four orderings, only range-then-range was actually deduplicated; the example the change was written for, a range read followed by a single page inside it, was one of the three that still paid twice. The ledger now sits beside the budget where both readers reach it, and a repeat is answered before the page is fetched, so it costs neither the tokens nor — on a page with no text layer — a second billed vision call. A page cut short is still continuable.
- **Withdrawing the outline tool mid-run cost more than it saved.** 7.1 dropped `document_outline` from the active tools once it had been used, to avoid carrying its schema. But the tool block sits ahead of the messages in the request and prompt caching matches on an exact prefix, so changing it threw away roughly 1,400 tokens of cached prefix on every remaining step to save about 150. The tool set is now fixed for the run, and the "the tree is already above you" nudge rides in the outline's own result, where it cannot invalidate anything. The usage panel's cached-token figures show the difference.
- **The search tool documented a default it had not used since 7.1.** Its `maxResults` still said "default 50" after the default became 12 — a false statement in the prompt, which is what the model reads when deciding whether to pass the parameter at all. Every stated default is now interpolated from the constant it describes, and a test fails if one is ever written out by hand again.

### Added

- **Alt+Up and Alt+Down walk the conversation.** The command palette covered every global action while the conversation itself could only be moved through with the mouse — which is worst exactly where it matters, twenty turns into a long document session. Focus moves a whole turn at a time, does not wrap at either end, and stops the view from snapping back to the newest message once you have left it.
- **Tests for the per-page deduplication, which shipped in 7.2 with none.** That absence is why the gap above survived a release: nothing asked whether the guarantee still held through a different tool. The new tests ask it per pair of tools rather than per implementation.

### Changed

- **Dependencies brought up to date** — seven patch releases including the AI SDK. The three major upgrades available (TypeScript 7, Vite 8, the React plugin) are each their own piece of work and are deliberately not riding along with product changes.
- **The panel convergence is finished, mostly by deciding not to convert things.** Of the 33 rules still declaring their own surface, almost none should be panels: some are inputs and tracks, three are card-shaped `<button>`s that would lose their semantics as a div, one is a `<details>`, and the rest are chips, code, kbd and a speech bubble. That reasoning is now written down beside the primitive so the count does not read as a to-do list. Five rules turned out to have no call site left at all and were removed.
- **The settings panel gave up its provider grid and its API key field** — 814 lines to 748, with the key-visibility toggle moving into the field that owns it.

### Notes

- One finding from this release's own review was withdrawn on a second look: clickable page citations were reported missing and are in fact fully implemented and tested, in files the first check did not open. That mistake and the deduplication gap above are the same error in opposite directions — concluding from one place that something holds everywhere.
- Splitting the settings panel is only partly done. What remains large there is state, not markup: the two async actions touch fifteen pieces of it, and hoisting them would trade a hundred lines for a parameter list nobody could read.
- `scripts/find-dead-css.mjs` reports 75 further class names with no use in the app. It reports rather than deletes on purpose — the first pass flagged rules that are assembled at runtime, and one that pdf.js writes into the DOM itself. Working through them is its own round.

## [7.2.0] - 2026-08-06

### Fixed

- **The same page could be bought twice in one answer.** The read budget counted characters but never recorded *which pages had already been returned*, so `read_pdf_range(10, 20)` followed by `read_pdf_page(14)` put page 14's full text into the context a second time and billed for it — and the duplicate was usually recent enough to survive in-run compaction untouched. A repeat now comes back as one line pointing at the copy already above it. The model loses nothing: the text is still in the conversation.
- **The in-run keep window had a floor of 24,000 characters per step.** It kept the four most recent tool results regardless of size, which treated a six-page range and a half-page read as equally expensive. It now keeps recent results up to a character budget, so an ordinary two-step read is never shortened while it is still being reasoned over and a run of large reads no longer carries four full pages on every remaining step.
- **Every tool result carried a paragraph of standing instructions.** The note about unindexed pages was 265 characters attached to two kinds of result — about a tenth of a default search's tokens, resent on every call, saying the same thing each time. The standing prose is now in the system prompt, where it is sent once and sits inside the cached prefix; results keep only the short part that actually varies.

### Added

- **Two or three things worth asking next, at the end of an answer.** Derived from what the run did — the section after the pages it read, the pages no search can reach, the passages you marked — not from a model. Every other agent that offers follow-ups pays for a second generation to invent three lines of text, and the last two versions were spent removing exactly that kind of cost. The document already knows what comes next, and asking it costs nothing.

### Changed

- **Spacing is on a scale.** 413 declarations used twenty different pixel values — 6px was more common than 12px, 10px more common than 16px — none of them chosen, each written next to the thing it padded. Seven named steps now cover it, and 388 declarations moved onto them; what is left is hairlines and a few deliberate layout offsets. This is the one change in this release that alters visual density, and it wants checking on a real screen.
- **The panel primitive is actually used.** 7.1 added `Panel` and then changed no call sites — its real usage count across the app was zero, while 79 CSS rules each defined a surface for themselves. The loading card, the search results, the confirm prompt, the mark note and the command palette now take their background, border and radius from one of three tones, and their own rules keep only what is local to where they sit.

### Notes

- Two candidates were deliberately not converted. The drop target is a dashed accent box and the settings callout is a warning-tinted strip: neither is a plain surface, and forcing the primitive onto them would have meant a tone fighting the panel's own colors. `.anchored-popover` was also left alone — it is already one shared definition covering five popovers, with a mutation-checked test guarding the transparency regression that shipped in 6.0.0, and moving its surface into JSX would have moved that guarantee out of where the test can see it.
- The review that produced this release proposed generating the follow-up suggestions with the SDK's structured-output support. That was not done: it would have restructured the answer stream to buy three lines of text that can be derived for free.

## [7.1.2] - 2026-08-06

### Fixed

- **Four controls came out of 7.1's shared-input work looking wrong.** The page box in the preview toolbar became a 32px bordered field inside a 36px toolbar, having lost the short, borderless, centred, tabular-figures look it needs there. The composer lost `resize: none`, so a drag handle appeared on a box whose height is already driven by the draft. The command palette's search field was forced to a fixed height its own padding overflows. The marks filter ended up with no rule at all, flush against both edges of the sidebar. Each is now the shared control plus only what is local to where it sits.
- **A reply that was only thinking became an empty message.** 7.1 strips reasoning from what is sent, and a run stopped mid-thought leaves an assistant turn with nothing else in it — so stripping produced a message with no content, which providers reject. The send path's empty-message guard runs earlier, so it could not catch this. Those turns are now dropped along with their reasoning.
- **A dialog opened and closed within one tick pulled focus back afterwards.** The focus trap deferred focusing the first control by a tick and never cancelled it, so the timer fired against an overlay that was already gone.

### Notes

- Two other timer and listener sweeps came up clean and were deliberately left alone: `yield-to-ui` clears the fallback it races, and the mark and index stores register `beforeunload`/`pagehide` handlers for the life of the process on purpose.

## [7.1.1] - 2026-08-06

### Fixed

- **Every dropdown in the app has been transparent since 6.0.0.** The usage panel opened as floating text over the conversation with nothing behind it — and so did the chat's overflow menu, the zoom presets and the model list. Removing the page-edge click targets in 6.0.0 merged their leftover selector onto the popover rule, leaving `.preview-canvas-wrap:hover .anchored-popover`: a popover only had a surface while the pointer happened to be inside the preview canvas. Four releases shipped that way.
- **Copy and Regenerate were reachable only from a few pixels.** They appeared when the pointer entered the thin footer strip at the bottom-right of a reply, which reads as buttons that do not work rather than buttons that were not found. They now appear when the pointer is anywhere on the message.
- **Copy could fail silently in some webviews.** `navigator.clipboard` needs a secure context and is not present everywhere a desktop build runs; when it is missing the call threw and the button looked like a no-op. There is a fallback now.
- **A failed tool run looked like a successful one.** The class marking the failure was applied from 6.x onward and never had a rule. The error line under the message editor and the raw provider metadata in the usage panel had the same problem: markup with no styling behind it.

### Added

- **A guard for the declarations the app cannot lose.** jsdom has no layout engine, so component tests cannot see any of this — and every rule now asserted has already broken in a shipped release: the popover's surface, the scroller's height (6.0.0's unscrollable document), the page clipping its own overlays, the focus rings, and reduced motion. The assertions read the stylesheet as text, which is crude and is the point: they are what stands between a careless edit and a release where a whole surface is invisible.

## [7.1.0] - 2026-08-06

### Fixed

- **Every question re-bought the previous questions' thinking.** Reasoning is produced as billed output, kept with the message so its fold can be opened — and then sent back as input on every later turn, because a stored reasoning part converts faithfully into reasoning content. Ten turns in, each question was paying for nine turns of old deliberation that the answers beneath it had already made unnecessary. Reasoning is now stripped on the way out; the fold on screen and the saved transcript are untouched. (This only ever affected people who turned thinking on — which is to say, people on the most expensive models.)
- **A conversation had no ceiling, only growth.** Tool results were compacted between turns, but the questions and answers themselves accumulated until a long session hit the model's context limit, which arrives as a failure rather than a gradual degradation. Older turns now fold into a single line naming what they were about, assembled locally — paying a model to summarize a conversation in order to save money is not a saving.
- **One search cost about 3,300 tokens by default.** Fifty hits, each with 240 characters of surrounding text. A model picks where to read from the first handful, so the default is twelve hits with 160 characters of context; `maxResults` is still there for when the long list is genuinely wanted, and `truncated` still says more exist.
- **The whole transcript re-rendered on every streamed chunk**, re-parsing the Markdown of every message on the way. Updates are throttled to roughly one per frame, which is all a screen can show.

### Added

- **A plan, not just a step number.** A run over a document has a shape — survey, locate, read, answer — and 7.0's counter said how far along it was without ever saying through what. The four phases are now shown with the current one marked, derived from what the run has actually done rather than from a plan the model was asked to declare (which would be another billed generation, and one it is free to ignore).
- **Sending during a run redirects it** instead of being refused. Changing your mind used to cost the whole run; now the pages it had already read stay in the local cache, so the replacement run picks them up for nothing and only the model call is repeated. The Stop button becomes Send instead as soon as there is something typed.
- **Steps show how long they took.** "Stuck" and "reading something large" looked identical.
- **A shared text input, and a shared panel.** Fifteen CSS rules each defined a full input box — border, radius, background, height, focus ring — for the composer, the settings fields, the page jump, the search box, the mark note. Every text input now comes from one component, with a `Field` that ties a label and its hint to the control for screen readers. Two remain outside it, and both are genuinely something else: a custom select trigger and a checkbox.

### Changed

- **The index tool retires once it has been used.** Its tree is in the transcript after the first call, so continuing to offer it costs its schema on every later step and invites a re-read. Tools are also offered in the order a document run reaches for them, which steers the choice without spending prompt on saying so.
- React updated to 19.2.8. Every other dependency was already current.

### Notes

- **Scanning a page still does not ask first.** The SDK's tool-approval mechanism would fit — a vision scan is the one action here that costs money — but per-page prompting is unusable on a scanned document, and the per-question allowance already bounds it. Left as it is, deliberately.

## [7.0.0] - 2026-08-05

### Fixed

- **A question re-sent the same pages up to twenty times.** A tool loop carries every earlier result forward on every step. Between turns that was already handled — a finished turn keeps `[Read page 12, 5,800 chars]` rather than the page — but *inside* a run every page stayed at full size for all remaining steps. A twenty-step run over six-thousand-character pages carried about 1.26 million characters of input, roughly 1.2 million of them the same pages again. Reads the model has moved past are now shortened mid-run to the same one-line summary; the four most recent are left whole, and the page text is still in the local cache if it is wanted again.
- **The prompt's cached prefix was thrown away on almost every turn.** The system prompt is the first block of a request and providers cache on an exact prefix — and it carried "the user is viewing page 47". In a reading tool that changes constantly, so each turn re-charged the entire conversation at full price. The per-message context now rides on the newest user message, leaving everything before it identical from turn to turn. **Tokens served from cache are now shown in the usage panel**, because the absence of that number is why nobody could see this.
- **The document index cost about ten thousand tokens whether or not anyone wanted it.** `document_outline` returned a 160-character preview of every page, up to 200 of them, in a single result — which the loop then resent on every later step. Previews are opt-in now and shorter; the section tree and per-page lengths, which is what planning actually uses, are unchanged.
- **Every step of a run reasoned as hard as the last one.** "Read page 14 next" was given the same reasoning effort as turning twelve pages into an answer. Fetching steps now use a low effort and the step that writes the answer gets the configured level back.
- **A reply had no length ceiling at all.** There is now a generous one, so a generation that runs away costs a bounded amount of money and time.

### Added

- **A shared button.** There were twenty-one button class names — `btn`, `icon-btn`, `settings-btn-primary`, `stop-btn`, `mark-ask-btn`, `toolbar-btn` and on — each with its own padding, height, hover and focus. None was wrong alone; together they meant no two buttons in the app were quite the same, which is what roughness looks like up close. All 44 buttons now come from one component with four intents and three sizes. Where a class remains it carries placement or a reveal-on-hover, not what a button is.
- **The steps of a run lead back to the pages they read.** The tool list showed "read page 12" as dead text while the "pages read" trail beside it was clickable — the same information, one of the two navigable. Every step that went to a page is now a link to it, and a failed step is marked as one.
- **A step counter while the agent works.** A twenty-step run showed one line that changed wording occasionally, with no sense of progress.

### Changed

- **The AI SDK and pdf.js are current again**: `ai` 7.0.14 → 7.0.52, `@ai-sdk/react` 4.0.15 → 4.0.55, `@ai-sdk/openai` 4.0.7 → 4.0.30, `pdfjs-dist` 6.1.200 → 6.2.108, `lucide-react` 1.23 → 1.28. The version range always allowed these; the lockfile held them back, so what shipped was thirty-eight patch releases old. Among them: per-step model settings (which the reasoning change above needs), tool parts surviving repeated call ids across steps, and errored replies staying loadable from a saved session. `repairToolCall` is no longer used under its `experimental_` name.

## [6.3.0] - 2026-08-05

### Fixed

- **Six CSS variables did not exist, and four of them were visible.** `var(--x)` with no fallback is silent: the declaration is dropped, so a colour quietly inherits and a background quietly goes transparent. In the light theme the **Mark** button on a selection was white text on a near-white surface — an empty rectangle. The note field on a mark and the edit box on a sent message had no background of their own. Hover and selected states in the outline and the sidebar tabs never brightened, which is what made them feel like they had not registered. The names were all from an earlier vocabulary (`--text-primary`, `--bg-primary`, `--bg`, `--radius-sm`); they now point at the tokens that exist, and `npm run check:css` fails the build on the next one.
- **Marks written off the page before 6.2 still drew over the neighbouring page.** 6.2 stopped a region drag from running past the page edge, but only where marks are made — every mark already in a file kept its out-of-bounds rectangle. Rectangles are now clamped to their page when drawn, so old marks land on the page they belong to, and a page clips its own overlays.
- **The buttons on a text selection stayed pinned to the window while the document scrolled.** Their position was measured once, and scrolling does not fire a selection event — so the passage slid away and the buttons did not follow. They now track the page. (The mark itself was always placed correctly; only the buttons drifted.)
- **The second selection button was positioned by the pixel width of the first one's English label.** A hard-coded 74px offset meant every other language stacked the two buttons or left a gap. They are one laid-out row now.

### Added

- **Ask about a mark.** Marking a passage in order to ask about it is the reason to mark it, and the only way to do it was to find the page again, find the passage again and select it again. Each entry in the marks sidebar now has an action that puts it into the composer, with its page number — a region mark with no words says where instead of what.

### Changed

- **The design system is now the one the stylesheets use.** It existed in `tokens.css` and almost nothing referenced it: 193 rules set a font size in pixels and 13 used a token. Type is six steps, and the bottom of the scale is 11px — the 27 rules at 10px and 3 at 9px are gone, because this is a tool for reading. Corners are three steps and a pill, where ten different pixel values had accumulated. Icon glyphs sized in pixels are deliberately left off the type scale: they are pictures, not text.
- **`AppV3.css` is gone**, merged into `App.css`. The name recorded which iteration of the shell it was, which stopped meaning anything once there was only one — and keeping it separate let the same selector be written twice with the winner decided by import order. Nine such collisions are resolved, including a toolbar button whose height was set in one file and its padding overridden from another, and a full copy of the light theme that had drifted from the real one.
- **38 rules that styled nothing were removed** — leftovers from three generations of shell (an old chrome, an old citation block, a session selector). Class names that are built up at runtime were left alone.
- **Motion respects `prefers-reduced-motion`.** Every transition here decorates something that is already correct without it, and the operating system already knows who does not want it.

## [6.2.0] - 2026-08-05

### Fixed

- **A region marked while the document scrolled landed in the wrong place.** The drag recorded its starting corner in window coordinates and read the page's position again only when the drag ended. Pointer capture holds pointer events but not the wheel, so scrolling mid-drag left those two in different frames of reference and shifted the whole rectangle by however far the document had moved. A drag is now measured in the page's own pixels, which cannot drift.
- **A region dragged past the edge of its page produced a rectangle outside that page.** Pointer capture keeps the whole drag on the page it started on, so it can be dragged onto the next page or into the gutter, and nothing clamped the result — the mark landed off the page and, since a page does not clip its contents, drew over its neighbour. A region now stops at the edge of the page it belongs to, and a drag entirely off the page marks nothing.
- **Home and End did nothing from within the first or last page.** They asked to go to page 1 or page N, and going to the page you are already on is not a move — so from halfway down page 1, Home was a dead key. They now go to the start and the end of the document, which is what they mean once a document scrolls.

### Added

- **The interface can be tested.** Until now not one of this app's 50 components had ever been rendered in a test: 424 tests, all of them over pure functions. That is the blind spot 6.0.0's unscrollable scroller shipped through, and where every 6.1 defect lived. There are now 24 tests that mount real components — the scroller virtualizes, reports the page the viewport is on, measures a bounded window, releases its container reference, and holds its pages still while scrolling; a region drag survives a scroll and stops at the page edge; Home/End and the arrow keys do what they say; and a settled page skips everything scrolled past. Each was checked against the defect it describes: reintroduce the bug and the test fails.

### Notes

- **jsdom has no layout engine.** It runs components, not CSS, so the specific failure in 6.0.0 — a flex child collapsing to zero height — still cannot be caught this way. What these tests cover is behaviour and collaboration, which is where three of 6.1's four defects were. Real layout still needs a real window.
- PostCSS (a build-time dependency of Vite) updated to 8.5.25, clearing a path-traversal advisory. It never shipped in the application.

## [6.1.0] - 2026-08-04

### Fixed

- **Scrolling through a scanned document could spend one billed vision call per page.** The preview indexes the page you are on when that page has no text of its own, and that call is not covered by either scan quota. While the preview flipped one page at a time, a click cost at most one call; once the document scrolled, the current page changed continuously, so scrolling once through a 200-page scan could bill up to 200 calls, unattended and without the confirmation the "scan every unscanned page" command asks for. The page you are looking at is now the page you have stopped on — half a second of stillness — and the pages you scroll past cost nothing.
- **Every mounted page re-rendered on every scroll event.** Each page received a freshly built overlay function on each render, so the memo meant to hold them still never matched, and each frame of a scroll re-reconciled every mounted page along with its highlight, mark, link and region layers. Pages now receive one shared function, and the scroll position is committed at most once per frame.
- **Opening a document measured every one of its pages.** A thousand-page document meant a thousand page loads in the background, none of which the reader had asked for. Pages are now measured around the window being read and as the reader moves; unmeasured pages are laid out at the first known size, as they already were.
- **The preview kept a reference to its scroll container after it was unmounted.** React 19 stops calling a ref callback with `null` once that callback returns a cleanup function, so the reference outlived the element — which is what decides whether a text selection belongs to the preview.

### Notes

- Fit-width now fits the widest page **measured so far** rather than the widest in the document, so reaching a landscape page mid-document narrows the column once. Measuring every page up front to avoid that is the unbounded chain removed above.

## [6.0.1] - 2026-08-04

### Fixed

- **6.0.0 could not change pages.** The scrolling container was sized by flex inside a row flex container that aligns its children to the top, so its height collapsed to the height of the whole column — leaving nothing to scroll. The page number moved and the view did not. It is now positioned against its wrapper and does not depend on the wrapper's flex alignment.
- **Zoomed past the window width, the left edge of the page was unreachable.** The column is now at least as wide as its widest page rather than always the width of the window.
- **The OS keychain was asked for the API key on every read.** Settings are resolved once per vision-indexed page, so indexing a scan meant a keychain round trip per page — and on macOS, where an unsigned build is a new application to the system after every update, a login-keychain password prompt per page. The key is now resolved once per session and forgotten whenever it is saved or removed.

### Notes

- **The repeated keychain and folder-permission prompts after each update are the unsigned build.** macOS ties keychain access and folder permissions to an application's code signature; an unsigned build's identity changes with every version, so the system treats each update as a different application and asks again. A Developer ID signature is stable across versions and both prompts stop. Signing needs credentials only the repository owner can add.

## [6.0.0] - 2026-08-04

### Changed

- **The document scrolls.** PageWise drew one page at a time and flipped between them: the wheel was a gesture that turned a sheet, not a scroll. A paragraph that crossed a page break had to be read in two halves, two facing numbers could not be compared, and finding a half-remembered figure meant clicking through the document a page at a time. Every page is now one continuous surface. Pages are virtualized, so a thousand-page document still holds only the pages you can see and their neighbours.
- **Page Up/Down move by a screenful** rather than by a sheet of paper, which is what they mean when a document scrolls. Home/End go to the first and last page; the arrow keys still move page by page.
- **A selection knows which page it is on**, rather than assuming the one the app called current. That is what makes marking work while the neighbouring page is also on screen.

### Removed

- The page-flip wheel gesture and its thresholds, the page-turn animation, and the click targets on the left and right edges of the page. All of them existed to turn a sheet.
- `prefetchPage`, `resolveFitWidthScale` and `hasPageCache`: the first warmed the next sheet, which mounting a neighbour now does; the second fitted one page, where the column fits its widest.

### Notes

- Fit-width now fits the **widest** page in the document rather than the current one, so a landscape page in the middle no longer reflows every page around it as you pass.

## [5.2.0] - 2026-08-04

### Added

- **Windows and Linux builds.** Every release now carries an `.msi` and an `.exe` installer for Windows and an `.AppImage` and `.deb` for Linux, alongside the macOS `.dmg`. Nothing in the code needed porting — there is not one platform-specific block in the Rust, and all three keychain backends were already compiled in — the release only ever built on macOS. Linux is built on Ubuntu 22.04 rather than the newest image, because a binary's glibc floor is the image it was built on.

### Changed

- **A failing platform no longer cancels the release.** The three builds are independent and the release publishes whatever succeeded, so one broken runner costs one installer instead of the whole version. A release with nothing built at all is still refused.
- **Everything that can fail without compiling now runs first** — tag/VERSION agreement, the CHANGELOG section, the secret scan and the tests — so a mistake there costs seconds rather than three platform builds.

### Removed

- `isEmbeddingCapableProvider`, left behind when semantic retrieval was pulled. Nothing had called it since.

### Notes

- **Still unsigned on every platform.** macOS Gatekeeper and Windows SmartScreen both block a first launch; README says how to get past each. Signing needs credentials that only the repository owner can add.

## [5.1.0] - 2026-08-04

### Fixed

- **A scanned page could not be marked at all.** Marking required selecting text, and a scan has no text layer — measured, zero selectable runs — so on exactly the pages vision indexing pays for, and on every figure and chart, nothing could be marked. Turn on region marking in the preview toolbar and drag a box instead. A region with nothing readable in it keeps an empty snapshot rather than the extractor's `[Image: …]` marker, which would have read as though those were the words on the page.
- **Release pages showed only the pull request title.** Every release body was GitHub's generated "What's Changed" line and nothing else, so everything the CHANGELOG says about a version stayed in the repository, where nobody downloading a build would look. The release now leads with that version's CHANGELOG section, and a version with no section fails the release before the build rather than publishing empty notes.

### Added

- **The document index lists the marks themselves**, not only which pages carry them. Asking the assistant to summarize what you marked previously cost one page read per marked page, for text already held in memory.
- **A filter box in the marks sidebar.** Notes are your own words and are in no search index — ⌘F covers the document, deliberately not this — so past fifty marks "where did I write that" had no answer.
- **Export marks on their own**, rather than only as a section at the end of the full document export.

### Changed

- **A region mark is drawn as an outline, not a wash.** Filling it would hide the figure it was drawn around, which is the thing it was drawn to look at.

## [5.0.0] - 2026-08-04

### Added

- **Marks.** PageWise was read-only: you read, you asked, and closing the document left nothing on it. Select a passage and mark it — with or without a note. Marks persist per document, list in the sidebar in page order, and come out with the Markdown export.
- **The assistant sees what you marked.** A marked passage is the strongest signal in a document of what its reader cares about, and it appears nowhere in the page text. Page and range reads return the marks they cover, and the document index lists which pages carry them. The assistant cannot create or change marks.

### Changed

- **A multi-line selection highlights line by line** rather than as one block over the paragraph, which would also cover the first line's left margin and the last line's right margin.
- **The outline tab is disabled rather than hidden** on a document with no recovered headings, now that the sidebar tabs are always shown so marks can be reached.

### Notes

- Marks are anchored on page geometry, never on text. Matching quoted text back to the page was measured first and rejected: page text and text positions come from different extraction paths that disagree, so only 24% of sentence-length quotes could be located, and even a 15-character anchor landed 71% of the time.
- A mark survives the file changing under it. The page-text cache discards itself on a file change because it can be recomputed; a mark cannot, so it is kept and flagged — the rectangle may point at the wrong place now, but the snapshot still says what was marked.

## [4.4.0] - 2026-08-04

### Added

- **The assistant can see where a link goes.** A hyperlink's destination lives in the PDF's annotations, never in the page text, so a page reading "See the specification and PageWise." gave no hint that two links were in that sentence. In one 117-page test document, 16 of 29 destinations could not be recovered from the text at all. Page and range reads now return the links on those pages, each with the line it sits on, and the document index lists which pages carry them.

### Changed

- **A clickable link in the preview announces the sentence it belongs to**, not just its raw address — for a link whose visible words are "the specification", reading out the URL was the least useful thing available.

## [4.3.0] - 2026-08-04

### Fixed

- **Searching a chapter name mostly found the chapter name.** Running headers arrived as body text, so a query for a heading matched the header printed at the top of every page in that chapter — 3 of 5 hits for one heading in a 117-page test document, each faithfully highlighted on the page. Lines that open or close a page, repeat in that position across several pages, and are short are now dropped. A heading is never dropped, whatever it repeats: one chapter in that document is both a title and, on the pages after it, a running footer.

### Added

- **The assistant is told which pages carry a figure.** `read_figure` shipped in 4.1 with nothing pointing to it — the document index listed pages with tables but never pages with figures — so the tool could only be reached by guessing.

## [4.2.0] - 2026-08-03

### Added

- **`read_section`** — the assistant can read a chapter by its heading instead of converting the outline it was just given back into page numbers and guessing where the section ends. A heading owns everything up to the next heading at its level or shallower, so a subsection no longer cuts its parent short. Boundaries come from headings recovered from the page text, so on a document whose headings are not visually distinct they can be approximate; reading by page range is still there for that.

### Fixed

- **A search hit could appear not to highlight.** Text runs with no width — 75 of 23,107 in one test document — produced an invisible box. They are now skipped at the source.
- **A heading pointing past the end of a document produced a page range over pages that do not exist.** Such an entry cannot describe a section, so it now yields nothing rather than an invented range.

### Removed

- The thumbnail sidebar's collapse rail, which could never render: its only caller passed `collapsed={false}`.
- `pdfType` and `confidence` from the data sent to the interface. Both remain in use inside the Rust side, where they decide whether a scan skips text extraction; one was assigned and never read, the other was sent and dropped.

## [4.1.0] - 2026-08-03

4.0 collapsed document parsing into a single call, but half of what that produced had no consumer: the outline was used only by the assistant, links and figure boxes were parsed and then ignored. This release adds no parsing — it connects what was already there.

### Added

- **Chapter navigation for documents with no bookmarks.** Most PDFs carry none, which left the thumbnail strip as the only way through a long document. The sidebar gains an outline tab, shown when the document has headings; the section you are in is highlighted and follows you.
- **Search results show where the hit is.** Clicking a result used to jump to page 42 and leave you to find the phrase. The hit is now marked on the page. The box covers the line rather than the exact characters — the extractor reports text runs, not glyph positions — and a phrase broken across two lines is not marked at all rather than marked in the wrong place.
- **The links inside a PDF are clickable.** Links outside the app's scheme allowlist are not drawn at all, and following one asks first and shows where it goes: a document's URLs are untrusted input.
- **`read_figure`** — the assistant can look at a single figure instead of sending the whole page to the vision model. Figures are ordered by size, decorative images under 24pt are skipped, and each call draws on the same per-question scan allowance as reading an unreadable page.

### Removed

- The `image` and `tempfile` crates, which had no references left in the Rust source.

## [4.0.0] - 2026-08-03

The document pipeline was replaced. Opening a PDF parses it once and produces everything the app needs from it — per-page Markdown, a chapter outline, hyperlinks and figure boxes — instead of pulling text, page counts and bookmarks from three different places.

### Changed (breaking)

- **PDF text extraction was replaced.** One parse now produces everything PageWise needs from a document — per-page Markdown, a chapter outline, hyperlinks and figure boxes — instead of pulling text, page counts and bookmarks from three places. Measured against the previous extractor on a 117-page textbook: 39% more text recovered, and 1.33s → 0.49s to open.
- **Tables keep their columns.** A financial table's cells used to arrive run together — `1,284` and `1,141` extracted as `1,2841,141` — which reads as one number that is wrong, with nothing on screen to suggest it. Page text is now Markdown, so the table survives into the answer.
- **In-document search reads the text, not its markup.** ⌘F and the assistant's search normalize Markdown first, so a query for a table cell matches and the quoted snippet is the row rather than a line of pipes.

### Added

- **Chapter navigation for documents with no bookmarks.** Most PDFs carry none — a 117-page textbook in the test fixtures carries zero — which left the assistant with per-page character counts and a 160-character preview to navigate by. Headings recovered from the page text now give it a real section tree; authored bookmarks still win where a PDF has them.
- **Export document as Markdown** (command palette). The page text is already Markdown, so the export preserves headings and tables; page boundaries are kept as HTML comments.
- **Selecting a table quotes it as a table.** "Ask about this" used to send whatever the text layer concatenated; it now re-reads the selected region, so a selected table arrives with its columns intact.

### Fixed

- **Freshly extracted text could overwrite text you had paid for.** Page versions were compared by length alone, and native extraction is reliably longer than a vision transcription of the same page — so a vision result could be discarded the moment it landed, and again on every reopen. Provenance now outranks length.

### Removed

- The `pdf-extract` dependency, and with it 72 transitive crates. Along the way: `getPdfPageCount`, `pdf_page_count_cmd` and `extractAllPageTexts`, none of which had callers, and the PDF-extract cancellation helpers, which have nothing left to cancel.

## [3.6.1] - 2026-07-29

Closes the loose end in 3.6.0: the scan budget it introduced governed only the background sweep, so it did not actually bound what PageWise could spend.

### Fixed

- **The assistant can no longer scan an unlimited number of pages while answering one question.** An agent page read indexes on demand — deliberately exempt from the sweep budget, so the page you asked about is never reported blank — but that exemption was per page and unbounded per run: asking about a 300-page scan walked the document one billed vision call at a time, and setting the budget to *Off* did not stop it. Agent-triggered scanning now has its own per-question ceiling (default 20 pages). On reaching it, the read tools return `scanLimitReached` and the model is told to answer from what it has and say some pages are unscanned, instead of retrying.
- **The prompt no longer steers the model onto the uncapped path.** The note attached to unindexed search results advertised reading those pages as free ("this triggers on-demand indexing"); it now states that each such read is a billed call drawing on a limited allowance.

### Added

- **Settings → General → Scanning** now has two controls, because the two kinds of spend are not the same thing: *Automatic scan budget* (pages the app may scan unprompted, per document) and *Assistant scan limit* (pages the assistant may scan per question). Either can be set to Off independently.
- **The chat offers to scan when it matters.** The unscanned-page count was previously visible only inside agent tool results, with no user-facing remedy but a command-palette entry. When the open document has pages with no text, the chat now shows the count with a one-click scan action (dismissible per document).
- The usage popover reports **scan calls** for a reply. Vision is billed per page image, so the request count describes the spend in a way the token totals do not.

## [3.6.0] - 2026-07-29

The first feature release since 3.5.10. One theme: **index once, pay once, and know what you paid.** Vision indexing is the only part of PageWise that spends money per page, and until now every scanned page was re-indexed — and re-billed — on each launch.

### Added

- **Scanned page text is now cached on disk.** Text recovered by the vision model is persisted per document, keyed by the file's modification time and size, and folded back in when the document is reopened. A scanned PDF is paid for once instead of once per launch; a file edited in place misses the cache and is re-scanned rather than being served text from its previous contents. The cache is bounded (24 documents / ~6M characters, oldest-saved evicted first) and a corrupt cache degrades to a miss instead of blocking the document from opening.
- **Settings → General → Scanning** shows what the scan cache holds (documents, pages, approximate size) and can clear it.
- **An automatic scan budget setting** (Off / 20 / 50 / 200, default 50 — the previous hard-coded value). This is the number of pages PageWise may send to the vision model on its own when a document has no text layer.
- **"Scan all unscanned pages"** in the ⌘K palette, with a confirm that states how many pages will be sent (i.e. how many billed calls) and how many scan calls the document has already used this session. This is the fix for search being blind past the automatic budget on a large scan: `search_in_document` only searches indexed text, so on a 300-page scan nothing beyond the first 50 pages was findable. The action is uncapped, explicit, and — because results now persist — a one-time cost per file.

### Changed

- The automatic sweep budget is read from preferences instead of a fixed 50, and `0` disables automatic scanning entirely. On-demand indexing of the page you are actually viewing is unaffected by the budget, as before.
- An explicit re-scan of a document now also drops its persisted index, so the next open doesn't restore exactly the text the user asked to discard.

### Fixed

- Buffered scan results are flushed when a document is switched or closed and on window close, so pages already paid for aren't lost with the process. A failed write returns them to the buffer for the next flush rather than dropping them.

### Notes

- The v3.5.13 entry listed a deferred perf item — large PDFs re-parsing the whole document on each single-page agent read. That note was stale: the Rust-side `PdfCache` (page text keyed by path + file stamp) already serves single-page reads from the parsed result, so single-page reads do not re-parse. No action needed; the note is withdrawn.

## [3.5.15] - 2026-07-18

Three genuine findings that survived a second third-party review's adversarial (refute-first) pass — verified against source; two others (a settings-persist race and a close-flush concern) were assessed as refuted/negligible and left alone, and the review's other two live items were already fixed in 3.5.14.

### Fixed

- **Chat history is no longer deleted for a document that simply fell out of the 10-item recents list.** The v3.5.13 orphan-chat cleanup pruned every chat whose document wasn't in Recent (capped at 10), so opening an 11th document deleted its saved conversation on the next launch. Cleanup now keeps chats for all recents and only trims once the store exceeds a generous cap (100), dropping the oldest non-recent chats — a user must open more than 100 distinct documents before any non-recent history is touched.
- **The "Retry" button now appears when a page's vision indexing fails.** A vision failure (often a transient network error) rendered the hint as a single "open settings" affordance and hid Retry whenever the settings handler was present — i.e. always in production — so the only recovery was to navigate away and back. Retry now shows alongside Settings for any failed index.
- **`search_in_document` now reports pages it cannot match.** Image/scanned pages with no extracted text aren't in the search index, so "no hits" there wasn't evidence a term is absent — but only `document_outline` surfaced that, and the model often searches first. Search results now carry an unindexed-page count/note, matching the read tools' `indexingFailed` signal added in 3.5.14.

## [3.5.14] - 2026-07-17

Fixes six genuine agent-blocking / cost issues confirmed from an independent third-party review of v3.5.12 (each verified against source before fixing).

### Fixed

- **Agent runs no longer hang when the window is hidden/minimized.** The between-tool-step yield chained `setTimeout` inside `requestAnimationFrame`, and an occluded WKWebView / minimized WebView2 pauses rAF — so a run could wedge before its next tool call with no recovery but restoring the window. The yield now skips rAF when the document is hidden and always races a timeout fallback.
- **Tool-capable models are no longer hard-blocked by a heuristic.** The composer blocked sending whenever `isToolModel` returned false, and its regex missed grok / kimi / glm / llama-4 / nova and other tool-capable OpenRouter routes — making the agent completely unusable on them. Sending is now gated only on a missing API key (matching the agent layer's own design intent); the capability warning still shows. The heuristic also recognizes those model families now.
- **Vision-indexing failures are no longer invisible to the model.** A read of a page whose vision indexing failed (missing key / error / 60s timeout) returned an empty string, which the model read as "this page is blank" — and could re-read, re-triggering a billed vision call each time. Read tools now report `indexingFailed` with the reason so the model can tell the user instead.
- **A run stopped by the meta-tool-loop guard now synthesizes an answer** instead of ending on a bare tool call (which surfaced as an empty "no reply"). When a meta-tool spin is imminent, the next step is forced to answer.
- **Page screenshots no longer pile up in every request or bloat the chat store.** On OpenAI-family multimodal models (which, unlike OpenRouter, keep image parts), a screenshot attached to a past turn was re-sent as base64 on every subsequent request (linear growth → eventual request-body overflow and total send failure late in a long chat) and persisted as multi-MB base64. Stale screenshots are now stripped from history before send and before persist.
- **A page read no longer returns blank when a background index sweep for the same page failed.** The dedup fast-path returned early whenever the piggybacked sweep task wasn't aborted — including when it *failed* — so an explicit agent read saw an empty page. It now runs its own indexing pass whenever the page is still un-indexed and the read is live (whether the sweep aborted or failed), at most once.

## [3.5.13] - 2026-07-17

Hardening pass from three fresh review angles (the v3.5.12 diff, a Rust↔IPC contract audit, and a cross-module state-machine sweep). No data-loss bugs found; the fixes below close a real error-reporting gap, a rotated-page selection defect, and a keychain-prompt storm.

### Fixed

- **Real PDF-load errors now reach the user instead of a generic "load failed".** Tauri rejects a command with a plain string, not an `Error`; the load-error path and the extract-cancel detector both tested `instanceof Error`, so "Encrypted PDF requires a password", "File too large", etc. collapsed to an empty/unclassified message. File-touching commands now normalize rejections to `Error`, and both call sites read string rejections too.
- **Text selection on intrinsically-rotated PDF pages (`/Rotate 90/180/270`) now aligns with the page.** The v3.5.12 off-DOM text-layer rewrite dropped pdf.js's `data-main-rotation` marker and the CSS lacked the matching rotation rules, so spans sat over an unrotated layout while the canvas was rotated. Both are now carried over/ported.
- **A blocked/denied keychain no longer triggers an OS-prompt storm.** A background index sweep called into the keychain per page (concurrency 3 × up to 50 pages); once the keychain is known blocked this session, migration and per-read fallbacks stop consulting it until the user reopens Settings.
- The asset-protocol PDF fallback works again — `connect-src` now allows `asset:`/`http://asset.localhost`, so a transient IPC read failure can actually recover via the asset protocol instead of hard-failing the load.
- A stale scope-cancel landing on a brand-new extract (stop a run, immediately send a new message) no longer surfaces a spurious "cancelled" — the fresh request retries once when it wasn't the one that aborted.
- Live activity progress (`onData`) is now generation-guarded like the other stream callbacks, so a buffered progress line can't leak under a document you just switched to.
- Removing the API key mid-index-sweep aborts the background queue once instead of marking every remaining page failed one-by-one.
- The streaming typewriter reveal self-terminates when caught up (no perpetual 12 ms wake-up during idle stretches of a run) while still never resetting on fast deltas.
- Chat export/summary, the Test-connection toast, and startup preference/recent loads got smaller correctness/robustness fixes; an aborted last message's finish time is stamped deterministically at save so its duration isn't inflated on reopen; failed-to-restore recent files are pruned from the list (and report the real cause, e.g. "No such file", not "path not authorized"); orphaned chats (documents no longer in recents) are evicted at startup so the chat store doesn't grow unbounded.

### Security

- `write_text_file` now authorizes writes only via an explicitly-registered parent **directory** (the save-as flow), not by the target file being in the read allowlist — the read allowlist no longer doubles as a write allowlist. `register_allowed_path` grants the asset scope before recording the path and no longer holds the lock across that call, so a failure can't leave the two out of sync.

### Known / deferred

- ~~A perf-only item (large PDFs re-parsing the whole document on each single-page agent read) is deferred: it needs a cached parsed `Document` on the Rust side, which can't be build-verified in the current environment.~~ **Withdrawn in 3.6.0** — the Rust `PdfCache` already keys extracted page text by path + file stamp and serves single-page reads from it, so no re-parse occurs.

## [3.5.12] - 2026-07-17

27-finding hardening pass from three deep-dive reviews (the v3.5.11 diff itself, the document pipeline, and chat-stream/UI internals). Two user-data-loss bugs and a broken selection-geometry contract lead the list.

### Fixed

- **Chat: send-time history repair can no longer delete the message the user just typed.** Stopping mid-stream could leave a corrupt tool call in history; the repair loop's fallback dropped the *last* row — the fresh user turn — making the question vanish and the model re-answer the previous one. Repair now removes never-completed tool parts at the root (instead of synthesizing schema-invalid calls) and, as a last resort, drops the newest non-user row, failing loudly rather than losing user input.
- **Chat: editing/regenerating a message no longer destroys it when the provider rejects the page screenshot.** The image fallback removed the row and then resent by its id — the resend threw "message not found" and the message was gone. Id-based resends now skip the rollback (the resend itself replaces the row).
- **Preview: text selection geometry now actually matches the rendered page.** pdf.js v6 positions text spans via CSS custom properties that need matching stylesheet rules; none were defined, so spans rendered at the app font size with no scaling/rotation. The viewer CSS contract is now ported (`--total-scale-factor` + span font-size/transform rules) — selection highlights align at every zoom.
- **Preview: retries after a failed PDF load/parse work again.** pdf.js *transfers* the byte buffer to its worker, detaching the cached copy — every second `getDocument` for the same file threw `DataCloneError`, defeating the stale-load retry loop. pdf.js now gets a copy, and a detached cache entry counts as a miss.
- **Chat: page-citation links no longer trigger on ordinary prose.** "step 5", "top 10", "MVP 2024", "webpage 5" all became bogus clickable page links; the pattern now requires a word boundary and a dot on p./pp. abbreviations.
- Chat: a transient 429/5xx on a web-search message no longer silently drops the search — the SDK's retry of that exact request keeps the injected plugin.
- Preview: the text-layer render path (newly reachable in production) guards its fit-width scale resolution and neighbor-page prefetch, surfacing/degrading instead of unhandled rejections; rapid page flips can no longer let a stale text-layer render wipe or interleave with the fresh page's spans (off-DOM staging + ownership token), and a teardown mid-render no longer leaks an uncancelled TextLayer.
- Documents: one malformed page no longer makes the whole PDF un-openable — Rust text extraction degrades that page to empty (vision indexing covers it) instead of failing the load.
- Agent: a page read that piggybacked on a background index task cancelled mid-flight (reindex/doc switch) no longer reports the page as blank — the read re-runs with its own signal.
- Chat: a stale send's late cleanup can no longer pop the *next* message's context (which hid all tools and answered "please open a PDF"); context rollback is now identity-based.
- Chat: the typewriter reveal no longer starves on fast streams — the pacing timer survives text growth instead of resetting on every delta (the live bubble used to render empty exactly when text arrived fastest).
- Chat: the "pages read" trail no longer overstates coverage — truncated range reads count only the pages the tool reported, cancelled/budget-refused reads don't count at all, and a malformed fractional range can't freeze rendering.
- Settings: a slow "Test connection" no longer snaps the panel back to the tested provider and discards the draft when you've switched providers mid-test.
- Chat: budget-refused tool outputs are kept verbatim in compacted history instead of becoming fabricated "0 hits"/"0 chars"; export-summary no longer feeds compaction placeholders to the model.
- Chat: exports strip leaked tool markup, include web-search sources, and represent image-only user turns instead of dropping them; a click on a linked image opens one URL, not two.
- Agent: a tool dispatched at the tail of an aborted run can no longer charge the next run's read budget (generation captured at dispatch); vision usage from indexing no longer inflates the footer's tokens-per-second.
- Documents: TIFF/BMP images are transcoded to PNG before vision/chat calls (providers reject those media types — indexing always failed); a cancelled page render is no longer JPEG-encoded and OCR'd; the 256 MiB read cap can no longer be bypassed via the asset-protocol fallback.
- Preview: per-page text content is cached once per page (not per zoom level) with an LRU bound; long agent runs no longer leak an abort listener per page read.
- Chat: the ⌘K palette's export commands are disabled mid-stream (matching the chat menu); re-arming the web toggle after a failed send respects a newer manual toggle.

## [3.5.11] - 2026-07-17

19-finding hardening pass from a full-repo review: agent cost rails, desktop text selection, chat-history resilience, and a prompt-injection exfiltration fix.

### Fixed

- **Preview: PDF text selection (and "Ask about this") now works in the desktop app.** The text layer was gated off in the Tauri runtime by a legacy v0.2-era condition, so selecting text — and the selection→ask affordance shipped in 3.5.6 — only worked in browser dev builds. The gate is removed; the raster/turbo-navigation guards remain.
- **Agent: `document_outline` and `search_in_document` now count against the run's read budget.** Previously both bypassed the 200k-char rail entirely — a 1,000-page PDF's outline alone produced a tool result larger than the whole budget, on the exact path the whole-document hint steers toward. Outline per-page stats are additionally capped at the first 200 pages (with a note pointing at search/read for the rest), and both tools return a compact `budgetExceeded` result instead of more bulk once the budget is spent.
- **Chat: corrupted chat history can no longer block a document from opening.** Persisted rows are normalized (malformed rows are skipped) and a history-load failure now degrades to an empty thread instead of failing the whole document open.
- **Security: assistant markdown no longer auto-loads remote images.** A prompt-injected document could make the model emit an image URL that exfiltrates document text on render. Remote images now render as a click-to-open link (local `asset:`/`data:` images still render); the CSP `img-src` is tightened to match.
- Chat: web search now triggers **one** OpenRouter search per opted-in message instead of injecting the plugin into every agent step (up to 30 billed searches per message), and the injection can no longer leak into unrelated requests such as connection tests.
- Chat: Retry/Regenerate now reuses the original message's web-search opt-in (and the 🌐 toggle re-arms if a web-enabled send fails) instead of silently retrying without it.
- Agent: "总结这个章节" / "分析这个表格" and similar section-scoped asks no longer trigger the whole-document reading directive — 这份/这个 now requires a document noun (文档/报告/论文/PDF/…).
- Agent: `maxResults` sent as a string by weak models is now repaired like the other numeric tool fields instead of failing the call.
- Preview: clicking a hallucinated/printed page citation ("page 57" in a 30-page PDF) now clamps to the document's page range, and a fit-width scale failure surfaces as a render error instead of a silent stuck canvas.
- Chat: a per-message "include current page" / web-search choice no longer leaks into the next document's Retry/Regenerate.
- Chat: a tool call cancelled mid-run is kept as `[cancelled]` in compacted history instead of being summarized into a fabricated hit/char count.
- Search: `truncated` is now exact (probes one hit past the cap), so "exactly N matches" no longer suggests more matches exist; degenerate over-long queries are bounded instead of inflating every snippet.
- Search: the live progress line now reports distinct matching pages instead of calling every match a page.
- Agent: `document_outline` no longer attempts a pdf.js parse of image documents on every call.
- Agent: a tool still in flight from an aborted run can no longer consume the next run's read budget.

### Changed

- Chat: agent progress lines ("Reading page 5…", "Searching document…") are now localized instead of always English.
- Agent: the whole-document hint now tells the model to stop reading and synthesize when the budget is exhausted, instead of pointing it at an infinite `truncated=true` loop.

## [3.5.10] - 2026-07-12

### Added

- Agent: `document_outline` now includes the PDF's native **section/bookmark tree** (title → page) when present, so the assistant can jump to a section ("summarize chapter 3") instead of scanning per-page previews.
- Chat: **opt-in web search** — on OpenRouter, a 🌐 toggle in the composer lets the model search the web for the next message (using OpenRouter's native search, citations shown as Sources). Off by default and per-message, not always-on — this is the correct-shaped return of the feature pulled in 3.5.1.

### Changed

- Agent: on the last allowed step of a run, the model is now nudged to answer instead of making another tool call, so a long investigation that reaches the step ceiling still produces a synthesis instead of ending empty.
- Search: `search_in_document` accepts an optional `maxResults` (default 50, up to 200) and reports truncation (carried over from 3.5.9).

## [3.5.9] - 2026-07-12

### Changed

- Agent: removed anti-agent-native limits so the model, not a heuristic, decides how to work. The whole-document intent keyword regex no longer gates how much of the document the agent may read — step and cumulative-read budgets are now uniform and generous for every run (20–30 steps, 200k characters), with the read budget as the sole cost rail, so a broad question phrased outside the keyword set ("review every section", "what recurs across the paper") is no longer silently capped mid-document.
- Agent: softened the system prompt from a fixed "search first, then read" / "outline first, then read in chunks" script into goal-oriented guidance — the model picks tools freely.
- Agent: grounding is read-first, not knowledge-limited. The assistant reads before answering and cites pages for document facts, reads the relevant page(s) before concluding something isn't in the document ("search found nothing" ≠ absent), and reads the page you're viewing when a question likely refers to it — then explains, reasons, and synthesizes freely, adding background knowledge when it helps. (Corrects a v3.5.8-in-progress over-restriction that would have limited answers to the document's literal text.)
- Search: `search_in_document` now accepts an optional `maxResults` (default 50, up to 200) and reports truncation, so the model can pull more than a fixed 30 hits; the match snippet is wider (48 → 120 chars) so a single hit is often enough to answer a lookup and a table/figure cell reads as a real match.

## [3.5.7] - 2026-07-12

### Added

- Chat: assistant answers now show a **"Pages read"** trail — the pages the agent actually read this turn, as clickable chips that jump the preview. Makes the agent's grounding visible and navigable.

### Changed

- Agent: the system prompt now asks the model to cite a page whenever it states a document fact and to quote key passages verbatim rather than paraphrasing — improving citation coverage (and making more of them clickable).

## [3.5.6] - 2026-07-12

### Added

- Chat: **page citations in answers are now clickable** — "page 5", "pp. 12–14", "第 8 页" etc. jump the preview to that page, connecting the answer to the document.
- Preview: selecting text in a PDF shows an **"Ask about this"** button that drops the quote into the composer and opens the assistant.
- Chat: richer, document-aware starter prompts on the empty state (including "Summarize all N pages").
- Settings: a **"Get an API key ↗"** link next to the API-key field for OpenAI / DeepSeek / OpenRouter.

### Fixed

- Chat: the window-close chat flush handler no longer re-registers on every streamed chunk (removes IPC churn during replies and a brief window where a close could skip the flush).
- Chat: chat persistence is now write-serialized, so a rapid autosave + clear can't resurrect a just-cleared conversation.
- Thumbnails: switching from a long document to a much shorter one no longer briefly renders a blank/flickering thumbnail list.
- Chat: an edit-and-resend failure now shows the real provider error instead of the generic fallback.
- PDF: a single-page read on a very large (200+ page) document no longer extracts the whole document up front, bounding worst-case latency.

### Removed

- Chat: deleted the never-populated structured-citations footer component (dead since v3.0.0); inline clickable citations replace it.

## [3.5.5] - 2026-07-12

### Fixed

- Chat: after pressing Send there's now immediate feedback — the thinking indicator and a working **Stop** button appear during the send/capture phase, instead of the panel looking frozen until streaming begins. Stop now also aborts a send that hasn't started streaming yet.
- Chat: the assistant streaming tail renders inline markdown (bold, italic, code, links) live instead of briefly showing raw `**` / `` ` `` characters until the paragraph closes.
- Chat: copy failures (clipboard unavailable) now show a toast instead of silently doing nothing.
- Thumbnails: the sidebar scrolls to and reveals the current page when the page changes (navigation, search jump, follow-agent) or when the sidebar is opened on a far page, instead of staying parked at the top.
- Search: an empty result on a document that is still being indexed now says so ("still being indexed, results may be incomplete") instead of a bare "No matches".
- Progress: fixed a duplicated first progress line at the very start of a response.
- Agent: an explicit page read (agent tool / preview) now completes and caches its text even if a background reindex bumps the document generation mid-read, instead of returning empty and reading as "this page has no content".

### Changed

- Chat: when a document is open but AI isn't configured, the composer shows a "Configure AI" button (which opens Settings) instead of a Send button that silently reroutes; the ⋯ menu shows a tooltip explaining it's available once there are messages; and the error line gains Retry and Dismiss actions.
- Security (hardening): opening a document now authorizes only that file for the backend, never its whole parent directory. "Save as" flows still authorize the specific folder the user picks, so writes stay scoped to a just-chosen directory rather than every folder a document was ever opened from.

### Performance

- PDF: single-page extraction now populates the page cache, so reading pages one-by-one no longer reloads and re-parses the whole document each time.

## [3.5.4] - 2026-07-12

### Fixed

- Agent: "this page" / "本页" / "当前页" questions now reliably resolve to the page you're actually viewing. The current page **number** is always shared with the agent as cheap text context, decoupled from the "include current page" preference — previously that preference (off by default) gated the page number too, so by default the agent had no idea which page was on screen and would answer about an arbitrary page.

### Changed

- Settings: the "include current page" preference now governs only the optional page **screenshot** sent to multimodal models (relabeled accordingly). The page number is shared regardless, so page-reference questions work without enabling it.

## [3.5.3] - 2026-07-12

### Fixed

- Agent: search no longer silently misses un-indexed pages. `document_outline` now reports pages that have little or no extracted text (e.g. scanned pages beyond the vision-index cap) as a compact range, with a note that `search_in_document` can't match them and they should be read directly — so the agent stops concluding "not in the document" for content it simply hasn't indexed.

### Changed

- Agent: raised the default per-run step ceiling from 12 to 15 so broad questions that don't match the whole-document intent keywords (e.g. "what are the main themes?") have room to traverse several pages before answering. Whole-document runs still scale up to 30, and the cumulative read budget remains the real cost rail.

## [3.5.2] - 2026-07-12

### Fixed

- Agent: whole-document summaries no longer silently claim full coverage on large documents. The per-run read budget now scales for whole-document runs (120k → 200k characters), and when the budget is reached the model is told to state that its answer covers only the pages actually read — instead of implying it summarized the whole document.

### Changed

- Agent: tool calls from weaker OpenAI-compatible models are repaired in code instead of burning a step on a schema error — numeric arguments sent as strings (e.g. `{"page":"5"}`) are coerced, and an inverted `read_pdf_range` (start > end) is swapped rather than rejected.
- Agent: with no document loaded, no tools are exposed, so the model asks the user to open a PDF instead of attempting tool calls that would fail (progressive tool disclosure).
- Agent: added one autonomy hint to the system prompt — read adjacent pages or search again when a single page doesn't fully answer, rather than answering a document-spanning question from one page.

## [3.5.1] - 2026-07-08

### Removed

- OpenRouter web search (the always-on `web` plugin from 3.5.0) — it searched on **every** message with its own auto-derived query, so document questions were answered with irrelevant web sources. Pulled the always-on trigger and the settings toggle; citation rendering is retained (dormant) for a future per-message opt-in design.

## [3.5.0] - 2026-07-08

### Added

- Agent: optional web search on OpenRouter — enables OpenRouter's built-in `web` plugin (the model's own server-side search) via a per-provider toggle in AI Provider settings, off by default. Uses the model's native search rather than a bespoke tool, so it costs no tool-loop tokens.
- Chat: web-search citations render as a "Sources" list under the answer (the model's `url_citation` annotations, forwarded as source parts). Shows nothing when there are no citations.

### Changed

- Agent: sending no longer pre-blocks on the tool-capability heuristic — an unknown model is allowed to try and surface the real provider error instead of being rejected up front; the capability warning still shows in settings.
- Agent: whole-document runs scale their step budget with page count (bounded at 30) instead of a flat 12, so a large document isn't cut off mid-read.
- Agent: trimmed the per-message view/whole-document instruction blocks to lean hints — less context bloat and less rigid scripting of the model, keeping only the essential directives.

## [3.4.3] - 2026-07-07

### Fixed

- PDF cache: capture the freshness stamp before parsing and key it on `(mtime, size)`, so a file rewritten during a slow parse (or within the same mtime tick) is re-parsed instead of served stale content forever
- Security: `write_text_file` rejects a symlink leaf outright and re-validates immediately before writing — closes a dangling-symlink escape (`Path::exists()` follows symlinks and misses dangling ones) and shrinks the check→write TOCTOU window
- Settings: language changes go through the locked `patchPreferences`, so a concurrent preference toggle can no longer be reverted by a stale read snapshot
- Settings drawer: the Escape-layer registration depends only on `open`, so an unrelated autosave tick can't shove the drawer above a higher overlay and mis-route Escape
- Confirm dialog: the mount effect runs once, so a parent re-render no longer steals focus back to the initial button
- Chat: Regenerate reads the current viewing page from a ref, so navigating the preview before regenerating uses the page you're actually on
- Usage: index-token accounting is attributed only to agent tool page-reads; background sweeps, on-view prefetch, and the connection probe no longer land on an unrelated chat message
- Toast: auto-dismiss timers are tracked and cancelled on manual dismiss
- Resize: an in-progress width drag is persisted if the handle unmounts mid-drag

## [3.4.2] - 2026-07-07

### Fixed

- Chat: reasoning-only assistant messages (e.g. a stream stopped before the answer) now promote their reasoning as the visible answer instead of rendering an empty collapsed block (`hasAnswerText` no longer counts reasoning parts)
- Settings: a transient store I/O failure during startup key migration no longer poisons the memoized promise for the whole session (reset-on-reject so reads retry) — previously it could wedge the settings UI on the loading skeleton
- Agent: the meta-tool loop guard now stops only on a genuine spin (the same outline/search call repeated), so distinct refined searches after a read are no longer truncated as a "loop"
- Streaming: a user abort mid-stream can no longer surface as an unhandled rejection when closing the progress-injection stream

## [3.4.1] - 2026-07-07

### Fixed

- Vision index: cap encoded page long-edge at `maxEdge` independent of display DPR — retina renders no longer upload ~2x the intended pixels/tokens (`visionRenderScale`)
- Chat history: tool-output compaction is now idempotent — re-pruning an already-compacted output no longer overwrites the original char/hit count with the summary's own length
- Secrets: keychain get/set/delete run off the main thread (`spawn_blocking`) so an OS prompt or Secret Service round-trip can't freeze the window
- Index events: `clearPageIndexState`/`clearDocumentIndexState` no longer re-insert an `idle` entry, so the per-page state map actually shrinks instead of growing across the session
- Session: guard the window-close listener registration against a rapid document switch tearing the effect down before it resolves (no orphaned close handlers)
- PDF bytes cache: refresh recency on cache hit so the LRU evicts least-recently-used, not least-recently-inserted
- Document search: trap focus within the search dialog like the other overlays
- Agent: meta-tool-only loop guard now fires on a recent all-outline/search window even if a read happened earlier in the run, instead of being disabled for the rest of the turn by a single early read
- Theme: OS light/dark changes in "system" mode now re-render `useTheme().resolved`, not only the `<html>` attribute

### Removed

- Dead code: unused `documentTools` export, unused `renderPageToPngBytes`, and the phantom `list_documents` activity label (+ its orphaned i18n key)

## [3.4.0] - 2026-07-06

### Fixed

- Agent: OpenRouter unknown models use tool-capability heuristics instead of hard reject (M8)
- Agent: stop meta-tool-only loops (outline/search without reads) via existing loop guards (M7)
- Settings: clear false "Unsaved" when edits match last saved snapshot (L1)
- Session: wait for stream idle before flush on window close; restore allowed paths on startup
- Markdown: strip react-markdown `node` prop from safe link/image renderers (L4)
- Connection status: fall back to `DEFAULT_SETTINGS.provider` when settings load fails (L6)
- Preview: clamp corrupted zoom values from localStorage (L13)
- Preview: remove dead `need_vision` index failure branch

### Changed

- Export chat: command palette uses session export; unified `{basename}-chat.md` naming (L5)
- Toast: reindex message explains 50-page vision limit

## [3.3.0] - 2026-07-06

### Security

- Asset protocol: remove blanket `$HOME/**` scope; allow only files registered via `register_allowed_path` (runtime `asset_protocol_scope.allow_file`)
- PDF: catch panics from `pdf_extract` in blocking workers; release profile uses `panic = "unwind"` so a malformed PDF no longer aborts the whole app (H6)

### Changed

- Agent: per-send view context flows through `runtimeContext` (transport consumes queue → `prepareCall` reads `messageContext`) instead of a second consume in `prepareCall`

## [3.2.0] - 2026-07-06

### Fixed

- Index queue: generation-aware cancel/restart; vision fetch aborts with queue signal; stale inflight no longer blocks reindex (H4/M4)
- Reindex: only clears page text for pages about to be vision-rescanned (max 50), preserving native text on other pages (H3)
- Images: multimodal chat sends `data:` URLs instead of local `asset://` paths (M2)
- Vision render: cap page JPEG/PNG scale to `maxEdge` (1568px) (M6)
- Session: read latest messages from ref on doc switch; flush chat on window close (M3)
- Theme: shared `ThemeProvider` so command palette and settings stay in sync (M9)

## [3.1.1] - 2026-07-06

### Fixed

- Agent: align prompts, prune list, and UI labels with actual tool names (`document_outline`); whole-document flow no longer calls removed tools
- Agent: `document_outline` outputs are compacted in chat history (token budget restored)
- Settings: "Discard & close" no longer persists abandoned edits on drawer unmount
- Index: cancelled vision scans emit `idle` instead of `failed`
- Chat persist: retry `Store.load` after a failed open instead of caching a rejected promise

### Changed

- Docs: README/CONTRIBUTING/SECURITY updated for v3 architecture (no Tesseract; correct transport and chat filename)

## [3.1.0] - 2026-07-06

### Changed

- Architecture slim (S1–S5): delete unused agent compaction/rerank/citations modules; clean OCR strings and dead CSS; `useWorkbenchOverlays` + `RecentFilesList`; extract `agent-stream-idle`

### Removed

- Dead v2 agent code: `agent-context-compaction`, `search-rerank`, `citations` parser, `model-routing`, `agent-run-plan`, `agent-activity-line`, `messages-signature`

## [3.0.3] - 2026-07-06

### Added

- Image documents restored: PNG, JPG, WebP, TIFF, BMP, GIF open with vision indexing and multimodal chat

### Fixed

- Session: transactional doc switch — defer cache commit until load + chat hydrate succeed; no eviction on failure
- Session: `waitForStreamIdle` before saving chat on switch; same-path re-open is a no-op; block opens while loading
- UI: clear-chat confirm uses overlay lock; settings and library drawer are mutually exclusive
- Recent files: Welcome and drawer share `openableRecentFiles()` filter and opening disabled state
- Index: dedupe per-page vision work; images use `readAuthorizedFileBytes` for scan
- Prefs: rollback follow-agent toggle on persist failure
- Follow-agent: tracks last assistant turn, not only while streaming

### Removed

- Dead v2 code: `ThreadSelector`, `chat-doc-snapshot`

## [3.0.2] - 2026-07-06

### Added

- Recent files drawer: Rail library button opens full recent PDF list (open, remove, switch document)

## [3.0.1] - 2026-07-06

### Fixed

- Session: chat hydrate after `chatId` aligns; abort in-flight loads on doc switch; isolate `saveChat` errors
- Index: use `loadVisionSettings()` for scan pages; reindex via `docCache.invalidateIndexedPageText`
- UI: wire composer prefs, `editUserMessage`, export summary, command palette, follow-agent
- Preview/search: sync `document` from `docCache`; text layer + search update when index completes
- Settings: `onApiReady`, preferences revision for preview quality

## [3.0.0] - 2026-07-06

### Changed (breaking)

- **Greenfield v3 architecture**: single `SessionProvider` replaces `useAppShell` / multi-hook orchestration
- **One PDF at a time**: `MAX_CACHED_DOCS = 1`; transactional `switchDocument` with chat persist per file path
- **Single chat thread** per document (`chat/persist.ts`); removed multi-thread UI, library drawer, command palette
- **Vision-only indexing** via `document/index-queue.ts`; removed OCR/Tesseract (Rust + UI)
- **Keyword search only**; removed semantic embeddings and `semantic-index`
- **Agent tools simplified** to `document_outline`, `read_pdf_page` / `read_pdf_range`, `search_in_document`
- **No structured citations** (second LLM pass removed); legacy citation metadata still displays from v2 chats
- **PDF only** — image documents no longer supported in `load-document.ts`

### Fixed

- Chat: composer draft state wired in `App.tsx` (v3 regression blocked all input)

### Removed

- `vision-index`, `semantic-index`, `embeddings`, `structured-citations`, `chat-sessions`
- `useAppShell`, `useDocumentWorkspace`, `useChatPersistence`, `useLibraryState`, `useAgentWorkspace`
- `LibraryDrawer`, `DocumentLibrary`, Rust `ocr.rs` and Tesseract commands

## [0.2.46] - 2026-07-06

### Fixed

- Reindex: invalidate `docCache` page text + semantic index; `forceReindex` bypasses cache short-circuit
- Index: `clearPageIndexState` emits `idle` to subscribers; background index no longer binds agent abort
- Index: pool 429 falls through to OCR; PreviewPane retries only on timeout (not rate limit)
- Reindex: single entry via `reindexActiveDoc` (removed `indexRevision` double-sweep)
- Chat: doc-switch snapshot taken after `waitForStreamIdle`; load failure triggers rollback
- Agent: send `finally` generation guard; image-fallback rolls back context queue; `clearChat` aborts citations
- Agent: `prepareForAgentSend` guards after `await`; `ChatPanel` uses `agentBusy` for interaction lock
- PDF: render stale checks after each `await`; cancel in-flight paints on `clearPdfCache`; text layer on cache hit
- PDF: thumbnails/text export honour stale callbacks; `readAuthorizedFileBytes` for vision images
- Rust: `read_file_bytes` size cap (256 MiB), chunked read with cancel generation; Tesseract 120s timeout + kill

## [0.2.45] - 2026-07-06

### Fixed

- PDF: single `clearPdfCache` owner on doc switch (removed duplicate from `usePdfViewer`)
- PDF: stale `getPdfDocument` loads retry instead of returning destroyed pdf.js docs
- PDF: `cancel_file_read_cmd` + JS generation guard discards stale IPC byte reads
- Index: `indexSparsePages` runs after workspace sets new abort controller (not during load)
- Index: auth/rate-limit vision errors surface as `vision_failed`, not `insufficient_text`
- Index: `embedMany` honours abort between batches
- Preview: reindex on successful connection test; `indexRevision` clears failed pages
- Preview: retry + settings for `vision_failed`; exponential backoff for rate limits
- Agent: `agentGenRef` guards `onFinish`, `onMessagesRepaired`, citations use live `totalPages`
- Agent: `deleteSession` resets agent; `waitForStreamIdle` timeout forces `resetForDocumentSwitch`
- Agent: regenerate truncates trailing assistant; `historySettling` cleanup on prune skip
- Chat: clear chat clears agent error state
- Rollback: `abortDocumentSwitch` reconciles PDF cache via `clearPdfCache`

## [0.2.44] - 2026-07-06

### Fixed

- PDF: `getPdfDocument` load-generation guard — stale loads no longer destroy the active preview document
- PDF: LRU cap on `pdfBytesCache`; prefetch skips non-active paths
- Agent: block doc/thread switch during pre-stream send (`sendGen`, `isAgentBusy`, `abortPendingSend`)
- Agent: `chatId` change stops in-flight send; image-fallback restores view context on retry
- Agent: regenerate reuses original `includeViewingPage`; rollback by `messageId`
- Chat: `waitForStreamIdle` waits for pre-stream send; 10s settle timeout
- Chat: `clearChat` creates a fresh empty thread instead of loading another thread's history
- Chat: `persistSignature` unified in doc-switch dirty detection
- Transport: sync UI when `validateChatMessagesForSend` repairs history
- Index: `abortDocumentSwitch` resets background index controller for rollback
- Index: OCR/render paths honor `AbortSignal`; `embedMany` passes `abortSignal`
- Index: search indexes sparse pages before keyword pass; background sparse index on doc open
- Index: `mergePageTextsOnReload` keeps vision/OCR text when PDF page count shrinks
- Agent: `assertPageInBounds` rejects reads when `totalPages === 0`
- Preview: no auto-retry on permanent `vision_failed`; indexed badge requires usable text
- Settings: custom provider skips vision without scan model; Ollama unknown models assumed tool-capable
- Settings:「设为活跃」shows model validation error
- UI: sidebar「已连接」requires tool-capable agent; persistence errors i18n (zh-CN)

## [0.2.43] - 2026-07-05

### Fixed

- Agent: Regenerate reads `messagesRef` — no stale user message after thread switch
- Agent: stop agent immediately when opening a new document (`onBeforeLoad`)
- PDF: scoped cancel generations (`load` vs `agent`) — doc load no longer kills agent tool reads
- Agent: remove duplicate `clearAgentRunAbortSignal` on status ready (transport owns lifecycle)
- Citations: `resetForDocumentSwitch` aborts in-flight `streamObject`
- Index: `abortDocumentSwitch` aborts background vision controller
- Chat: `selectThread` reports errors; `persistSignature` unifies dirty detection
- Chat: tab-hide save failure surfaces toast

## [0.2.42] - 2026-07-05

### Fixed

- PDF (Rust): single-page `read_pdf_page` extracts one page only — no longer parses the entire document on cache miss
- PDF (Rust): cooperative cancellation via `cancel_pdf_extract_cmd` — Stop, doc switch, and superseded opens bail out between pages
- PDF: `getPdfPageCount` uses fast `pdf_page_count_cmd` instead of full text extraction
- Load: opening a document accepts `AbortSignal`; switching files aborts the previous Rust parse

## [0.2.41] - 2026-07-05

### Fixed

- Agent: keep abort signal wired until the UI stream finishes — Stop now cancels in-flight tools (PDF read, search, vision index)
- Chat: delete thread / clear chat / delete session wait for stream idle before mutating messages
- Citations: abort in-flight `streamObject` on new send or thread switch; reuse per-run settings snapshot
- Model: unknown Ollama/OpenRouter ids no longer assumed tool/vision-capable (indexing skips spurious vision attempts)

## [0.2.40] - 2026-07-05

### Fixed

- Chat: `validateChatMessagesForSend` repairs corrupt history (dangling tools, empty assistants) instead of blocking sends
- Agent: PDF page text extract honors AbortSignal — Stop returns immediately even if Rust IPC is still running
- Sessions: `saveActiveSession({ touchActive: false })` for background/doc-switch saves; explicit API prevents stealing active thread

### Added

- Tests: `validate-chat-messages`, `structured-citations`, `chat-persistence-flow`, transport abort lifecycle

## [0.2.39] - 2026-07-05

### Fixed

- Agent: honor Stop during PDF text extract and semantic search (abort checks + embed signal)
- Agent: snapshot settings per run so mid-run provider changes cannot swap models
- Agent: regenerate rebuilds page screenshot via `buildSendPayload` (same as edit/send)
- Agent: citation generation cancelled on new send; `citationsError` shown in footer
- Vision: block scan API when custom provider has no Base URL
- Model: unknown OpenRouter models no longer assumed tool-capable
- Runtime: default doc path only when exactly one document is loaded
- Chat: edit resend failures show inline error; autosave signature matches pruned disk shape
- Sessions: saving a background thread no longer steals `activeSessionId`
- Settings: prefer local API key mirror over keychain on every read
- Preferences: serialize read-modify-write with store lock

## [0.2.38] - 2026-07-05

### Fixed

- Chat: document switch no longer loses unsaved messages when `chatId` recreation clears in-memory state (per-doc snapshot cache)
- Chat: update `threadSessionId` before hydrating messages so thread/doc loads are not wiped
- Chat: wait for stream idle before doc/thread switch saves; quit flush fails closed after 5s timeout
- Chat: autosave works after delete-session / failed load while document stays open
- Agent: prune bulky tool outputs after error responses; clear abort signal in transport `finally`
- Preview: follow-agent ignores previous assistant tools while a new reply is in flight

## [0.2.37] - 2026-07-05

### Fixed

- Agent (OpenRouter): stop attaching page screenshots — AI SDK sends raw base64, which OpenRouter tries to fetch as a URL (`Failed to download image from iVBORw0…`)
- Chat: strip persisted user image parts on load/send for OpenRouter; text page context still injected

## [0.2.36] - 2026-07-05

### Fixed

- Agent: `sendMessage` failures are detected via `onError` (AI SDK does not throw) — image fallback, rollback, and regenerate error handling now work
- Preferences: “Include current page” no longer defaults to on before preferences load

## [0.2.35] - 2026-07-05

### Fixed

- Agent: OpenRouter page screenshots limited to verified routes (`openai/gpt-4o*`); Gemini/Claude no longer attach images (fixes false “scan model” errors and send failures)
- Agent: image-reject retry removes duplicate optimistic user row before resending text-only
- Agent: distinguish assistant vs scan image errors; auto-retry without screenshot when provider rejects images
- Chat: sanitize loaded sessions (drop `parts: []`) so corrupted history cannot block all sends
- Preferences: default “Include current page when asking” off — page context still injected as text

## [0.2.34] - 2026-07-05

### Fixed

- Chat: strip or reject messages with `parts: []` on load, persist, and send (fixes `validateUIMessages` "Message must contain at least one part" after stop/quit mid-stream)
- Chat: aborted assistant placeholders with no parts are removed on finish instead of being saved

## [0.2.33] - 2026-07-05

### Fixed

- Search: capped semantic embed merges vectors across rotations (full-doc coverage over rebuilds)
- Search: partial capped indexes no longer permanently disable semantic search after retry cap
- Search: opening a document no longer aborts its own in-flight embed build
- Chat: quit/hide while streaming stops the agent and flushes before close
- Chat: window stays open when flush fails on quit (no silent data loss)
- Chat: document-switch save failure reverts preview to the previous document
- Chat: `persist_cancelled` no longer surfaces as a user-facing error toast
- Chat: thread switch hydrates messages before updating `chatId`
- Chat: composer draft clears on thread switch
- Agent: structured citation extraction skips `reasoning` (provider compatibility)
- Agent: citation extraction ignores stale callbacks after thread/doc switch
- Agent: `read_pdf_range` rejects inverted ranges and out-of-range start pages
- Agent: force read tools before synthesis/meta-loop guards (search→read flow)
- Agent: detect `budgetExceeded` inside AI SDK JSON tool-result envelopes
- Agent: do not reset read offset when page text shrinks after re-index
- Agent: `read_pdf_range` reports `requestedEnd`, `actualEnd`, and `rangeClamped` when end exceeds document length
- Chat: `messagesDocPathRef` prevents cross-document autosave corruption
- Chat: abort document switch when pre-save fails; clear messages on load failure
- Chat: loading overlay during thread/doc switch; cancel edit mode on switch
- Chat: history prune scoped to `chatId` (no cross-thread truncation)
- Chat: Tauri `onCloseRequested` awaits flush before window destroy (replaces unreliable `beforeunload`)
- Preview: follow-agent skips loaded history when no live agent context
- Search: per-document semantic embed abort (switching docs no longer cancels other builds)
- Search: embed cap uses spread sampling + rotation so tail pages eventually get vectors
- Search: drop partial semantic index after embed retry cap (rebuild on next open)
- Agent: `isAgentMultimodalModel` — only known vision+tools models get page screenshots
- Agent: structured citation extraction records `citationsError` metadata on failure
- LLM: parse OpenRouter `metadata.raw` for actionable provider errors
- LLM: skip fast-model routing for unknown OpenRouter model ids (no invalid fallback)

## [0.2.32] - 2026-07-05

### Fixed

- Chat: `useChat({ id })` binds synchronously — thread switch no longer writes messages to stale chat instance
- Chat: delete session syncs `chatId` with persistence (`onActiveSessionIdChange`)
- Chat: document switch blocks autosave during transition; persist failure no longer leaves cross-doc corruption
- Chat: `chatLoading` gates composer during thread/doc switch (prevents send during load)
- Chat: `switchThread` returns resolved session id when requested thread is missing
- Settings: V1 migration and keychain migration preserve plaintext mirror when keychain write fails
- Settings: keychain preferred over stale disk mirror; reconcile no longer aborts all providers on one failure
- Settings: `useConnectionStatus` handles load failures instead of hanging unconfigured
- Agent: only attach page screenshot when assistant model supports vision (fixes OpenRouter “Provider returned error”)
- Agent: map generic provider errors to actionable guidance

## [0.2.31] - 2026-07-05

### Fixed

- Agent: Stop now cancels in-flight tool-time indexing (abort signal kept until stream ends)
- Indexing: semantic embed build capped with failure backoff; no infinite retry loops
- Indexing: closed documents abort background indexing via doc cache guards
- Chat: persist failure blocks thread/document switch; autosave epoch bumped on delete
- Chat: `visibilitychange` / `beforeunload` flush reduces message loss on crash
- Search: document search always clears loading state on error
- Settings: test connection triggers reindex when scan model changes
- Settings: plaintext API key fallback surfaces a security warning in AI provider settings
- Preview: transient index failures auto-retry after 4s

### Added

- Vercel AI SDK: `useChat({ id })` binds chat to document thread session
- Vercel AI SDK: `rerank()` on semantic search hits (fuse + rerank path)
- Vercel AI SDK: `streamObject` for streaming structured citations in message metadata
- Vercel AI SDK: `output-error` tool steps shown with failed state in chat UI
- Vercel AI SDK: `sendMessage({ messageId })` edit-and-resend for last user message
- Vercel AI SDK: multimodal `files` part when sending with viewing page attached
- Vercel AI SDK: provider metadata and final-step tool names in usage stats popover

## [0.2.30] - 2026-07-05

### Fixed

- Settings: `hasStoredKey` probes Keychain so Agent UI no longer misreports missing API keys
- Settings: keychain migration no longer writes plaintext keys when Keychain is available
- Settings: serialized store writes prevent concurrent settings corruption
- Settings: test connection runs before persisting profile (no save-on-failed-test)
- Settings: About page shows chi_sim Chinese OCR pack status
- Settings: General tab keeps preference defaults in local state (decoupled from active doc)
- Chat: unified `opGenRef` guards document/thread switches against stale loads
- Chat: autosave updates snapshot from outgoing messages; metadata in signature
- Chat: persist errors caught on switch/autosave; `newThread` generation guard
- Chat: thread selector UI (switch / new chat per document)
- Chat: document switch no longer clears messages before persistence loads
- Chat: agent abort signal cleared when stream ends
- Search: semantic index keeps dirty on abort/incomplete builds; live page cache in search
- Search: document search uses request generation + loading state
- Indexing: join inflight runs honor agent Stop abort; doc-close abort via cache check
- Indexing: `insufficient_text` only when both vision and OCR fail
- Indexing: page text upserts merge with `pickBetterPageText` (agent + cache)
- Preview: retry button on failed page index; PDF cache cleared only on path change
- Shell: API ready no longer triggers automatic full reindex
- Shell: AppRail connected when API key is configured (not gated on tool model)

## [0.2.29] - 2026-07-05

### Fixed

- Preview: stop infinite re-index loop on permanently failed pages (retry only on reindex)
- Chat: persist messages on document/thread switch even during streaming (sanitized + pruned)
- Chat: autosave binds session id at schedule time (no cross-thread corruption)
- Chat: stronger message signature for dirty detection; prune tool outputs on persist
- Agent: keep abort signal alive until stream ends so Stop cancels tool-time indexing
- Search: semantic index rebuilds when dirty after in-flight OCR; guard zombie writes on doc close
- Search: UI document search uses hybrid semantic + keyword (aligned with agent)
- Indexing: OCR render capped at 1568px edge like vision path
- Indexing: joined inflight index runs honor caller abort signals
- Settings: API keys only mirrored to disk when keychain unavailable
- Settings: no silent reset of user-selected chat-only agent models on restart
- Settings: close confirm when AI tab dirty on any settings tab
- Preview: sanitize index error details; i18n render failures
- Chat: regenerate gated on API key and tool support like send
- Merge: prefer substantially longer native extract over stale OCR on reopen
- Rust PDF cache: LRU touch on hit

## [0.2.28] - 2026-07-05

### Fixed

- Chat: stop streaming when switching threads or reloading the same document
- Chat: skip autosave of truncated replies while a stream is in progress
- Chat: update loaded snapshot after autosave to avoid redundant writes
- Indexing: reopen merge prefers cached vision/OCR text over Rust re-extract when both meet threshold
- Indexing: Stop aborts in-flight tool-time page indexing via shared abort signal
- Indexing: unified per-page inflight dedupe (no duplicate pool/single runs)
- Search: semantic index build uses single-flight lock (no concurrent double-build)
- Search: toast when semantic embedding hits the 50-page cap
- Reload: same-path reopen preserves index UI state instead of clearing badges
- Settings: custom provider with empty scan model no longer falls back to agent model (OCR-only)

## [0.2.27] - 2026-07-05

### Fixed

- Agent: PDF extract path now requires ≥20 chars before returning (aligned with vision index threshold)
- Indexing: reopening the same file preserves vision/OCR text instead of wiping the cache
- Search: semantic index rebuilds correctly after background indexing and document reload
- Chat: unsaved messages are persisted before same-path document reload
- Indexing: separate in-flight dedupe for preview vs bulk sweep (429 halt works correctly)
- Preview: re-index when status is `done` but page text is still too short
- Settings: block provider switch / set active when save fails
- Settings: preserve explicit DeepSeek scan model distinct from agent model

### Changed

- Settings: custom provider gets a dedicated scan model field
- Indexing: cap toast reports successful pages; partial-failure toast when some pages fail
- Doc cache: `remove()` also clears per-page index state

## [0.2.26] - 2026-07-05

### Fixed

- Indexing: clear stuck “Indexing…” badge on document switch or abort
- Indexing: dedupe concurrent per-page index runs; cancel background index on doc switch
- Indexing: custom OpenRouter/Ollama scan model IDs are no longer silently replaced at runtime
- Indexing: fall back to local OCR after vision rate-limit (429), not only on other errors
- Indexing: retry when index state is `done` but cached text is still too short
- Agent: `read_pdf_page` waits for sufficient indexed text (≥20 chars), same as background index
- Agent: stream setup errors propagate correctly (no masked `undefined.stream` TypeError)
- Settings: persist unsaved edits before switching AI provider tab
- Settings: custom assistant and scan model IDs allowed; test connection probes scan model for all providers

### Changed

- Settings: optional scan model input when provider has no scan presets (e.g. DeepSeek)
- Indexing: toast when background sweep hits the 50-page cap
- Vision API: restore index token usage tracking; faster JPEG data-URL encoding
- Doc cache: evicting a document also clears its index state

## [0.2.25] - 2026-07-05

### Fixed

- Indexing: send scan images as `data:image/jpeg;base64,...` URLs (fixes OpenRouter “Invalid URL format: /9j/…”)

## [0.2.24] - 2026-07-05

### Fixed

- Indexing: migrate away from unreliable `google/gemma-4-31b-it:free` scan preset; test scan model on “Test connection”
- Indexing: surface API error details in preview badge when vision extraction fails

### Changed

- OpenRouter scan presets: remove Gemma 4 free tier; keep Gemini Flash Lite, Qwen3-VL, Gemma 3

## [0.2.23] - 2026-07-05

### Fixed

- Indexing: retry after failure when scan model changes; reindex active doc on scan model save
- Indexing: show “check API key and scan model” when vision API fails (not misleading Tesseract hint)
- Indexing: use `image` content type for vision API; fall back to default scan model when stored id is not vision-capable

## [0.2.22] - 2026-07-05

### Fixed

- Settings: scan model always shows preset dropdown (custom input only after choosing “Custom model…”)
- Settings: migrate legacy shared agent/scan model id to default scan preset on load

### Changed

- Settings: reorganize AI provider into Connection / Models / Advanced sections
- Settings: rename “Indexing model (vision)” → “Scan model”; add field hints for assistant vs scan
- Settings: show Extended thinking only for DeepSeek-capable assistant models; auto-clear when unsupported
- Settings: simplify provider grid (remove badge clutter; dot marks provider in use)

## [0.2.21] - 2026-07-05

### Changed

- Settings: simplify AI provider presets to flat assistant + scan model lists (OpenRouter 2+4 models)
- OpenRouter scan default → `google/gemini-2.5-flash-lite`; add Gemma/Qwen3-VL free and budget options
- Remove outdated OpenRouter presets (72B VL, Claude, Chat-only DeepSeek routes)

## [0.2.20] - 2026-07-04

### Fixed

- UI: move agent progress inline below the current turn (inside the assistant bubble / pending reply), not fixed at panel top
- Streaming: client-side segment reveal during live answers so text animates even when the provider batches one large delta

## [0.2.19] - 2026-07-04

### Fixed

- Agent: wire targeted factual queries to a real 6-step cap (`stopWhen` + `prepareStep`) instead of display-only
- UI: show step progress from step 1 with elapsed time at 0s; keep progress bar visible during reasoning-only phases
- Streaming: replay agent progress emitted before the UI stream subscribes (search-hit preview no longer dropped)

## [0.2.18] - 2026-07-04

### Changed

- Streaming UX: CJK-friendly `Intl.Segmenter` chunking without artificial delay; plain-text tail while live, full markdown when done
- UI: single unified progress bar with step index, elapsed time, and search-hit preview; tool fold collapses when idle
- Agent: targeted factual queries cap at 6 steps; synthesize immediately after read/search tools; brief status sentences in system prompt
- UI: lower substantial-text threshold (8 chars, includes reasoning); reasoning expanded during live stream; settling transition after history prune

## [0.2.17] - 2026-07-04

### Fixed

- Agent: `compactStaleToolResults` now preserves `ToolResultOutput` schema when truncating tool results, fixing `Invalid prompt: The messages do not match the ModelMessage[] schema` on multi-step runs

## [0.2.16] - 2026-07-04

### Fixed

- UI: strip spaced-pipe DSML tool markup (`< | | DSML | | invoke …>`) leaked as plain text by some providers
- Agent: force synthesis when a step’s answer text is DSML-only (tools ran but no user-visible reply)

### Changed

- Assistant footer: remove inline usage summary and per-step breakdown; full stats remain in the usage popover only

## [0.2.15] - 2026-07-04

### Fixed

- Save/export: saving to a new file name no longer fails (`write_text_file` canonicalized a not-yet-existing target)
- Settings: editing an existing API key value is now persisted (dedup no longer collapses every key to a constant); explicitly-cleared keys are not resurrected when the keychain becomes available
- Storage: `recent-files` and `allowed-paths` serialize read-modify-write, preventing dropped entries under concurrent startup restore and user actions
- Semantic search: gate embeddings on provider capability instead of silently degrading to keyword; invalidate the index when OCR/vision text lands so scanned pages become searchable; bounded-batch embedding with per-batch failure isolation, page cap, 429 backoff, and abort; rebuild on embedding model/dimension drift
- Search ranking: fuse keyword + semantic results (Reciprocal Rank Fusion) instead of ranking purely by lexical term count
- Agent usage: per-step token counts are no longer double-counted (single-step replies showed "2 steps" and ~2× tokens)
- Agent: aggressive context compaction no longer forces synthesis on the same step it prunes; fast-model routing only applies to intermediate steps so the final answer uses the configured model; the final step is reserved for synthesis so a run cannot end without an answer
- PDF preview: thumbnails no longer stay permanently blank after a page turn cancels them; quality toggle keeps the loaded document instead of re-reading the whole file
- Citations: hallucinated pages beyond the document length are dropped; inverted ranges normalized

### Changed

- `read_file_bytes` returns raw bytes over IPC instead of a JSON number array (faster, less memory for large PDFs)
- Rust PDF text cache releases its lock during extraction and is bounded to 12 documents
- Vite build target set to `safari15` to match the WKWebView runtime baseline
- Usage-stats popover is keyboard/Escape dismissable; a single streaming status indicator is shown while awaiting the first reply

## [0.2.14] - 2026-07-04

### Fixed

- Agent: stop meta-tool loops (`list_documents` / `get_document_index` / `search_in_document` without reading pages)
- UI: strip DSML tool-call markup leaked as plain text by some providers (e.g. DeepSeek)

### Changed

- Agent: force `read_pdf_*` after search; block repeat list/index calls; cap steps at 14
- Agent: lower aggressive compaction threshold (20k cumulative step input tokens)

## [0.2.13] - 2026-07-04

### Fixed

- Agent: fix streaming status disappearing on follow-up questions (`lastAssistant` pointed at the previous turn)
- Agent: continuous progress stream pump; placeholder bubble while awaiting first assistant chunk
- Provider: omit `reasoning` when thinking is off (fixes `reasoning_effort: unknown variant none` on switch)

### Changed

- Agent: AI SDK `prepareStep` compaction — tiered `pruneMessages` by tool type, usage-driven aggressive mode, synthesis step disables tools
- Agent: read tool default max chars 8k → 6k; compact search/index outputs in stale steps
- Usage: inline token summary on assistant footer; per-step breakdown expands when multi-step; live updates on `finish-step`

## [0.2.12] - 2026-07-04

### Fixed

- Agent: keep status visible during tool/reasoning phases; show "generating answer" between tools and final reply
- Streaming: reasoning block auto-expands while live; markdown stream caret during answer generation
- Tool steps stay expanded until the assistant message finishes

### Changed

- Agent: aggressive `prepareStep` pruning and stale read-tool compaction to lower multi-step input tokens
- Read tools default max chars reduced from 12k to 8k per call
- Usage stats label clarifies total input includes all agent steps; splits agent vs index when relevant
- Assistant footer actions use ghost icon buttons aligned with v3 message styling

## [0.2.11] - 2026-07-04

### Added

- Assistant message footer: copy, regenerate, and usage stats popover (input/output tokens, TTFT, speed, index vs chat split)
- Agent: `smoothStream` word chunking, structured citations via `generateObject`, and live tool-progress data parts
- Search: hybrid keyword + semantic retrieval with embedding index and lexical `rerank` pass
- Agent loop: `runtimeContext` default doc path, `prepareStep` fast-model routing, and `pruneMessages` for long contexts
- Export summary: `streamObject` structured Markdown export with streaming generation
- Debug: per-step token usage in stats popover (`onStepEnd` metadata)
- Tests: `ai/test` mocks for transport metadata, rerank, and export summary

### Changed

- Thinking/reasoning: top-level AI SDK `reasoning` parameter replaces custom fetch body injection (OpenRouter headers only)

## [0.2.10] - 2026-07-04

### Fixed

- Agent: prevent overlapping sends during settings load; rollback view context on send failure; restore composer draft on errors
- Settings: vision model restores correctly when switching providers; vision-only edits persist via debounced save
- Settings: explicitly cleared API keys are not re-imported from Keychain on migration retry
- PDF preview: cancelled renders are no longer cached as valid frames
- Indexing: clear stale index state on document reopen/reindex; require MIN_INDEX_CHARS before marking done; honor abort before OCR
- Path restore: prune missing paths from recents (no repeated startup toasts); register `/` parent for root-level files
- Security: `write_text_file` canonicalizes target path and rejects symlink escapes
- Streaming markdown: fence-aware paragraph split; tail renders markdown during live stream
- MessageContent: stronger parts signature and live prop memo; unique tool detail keys
- Follow agent: sync to the latest read tool page; re-scan when re-enabled
- docCache: evict oldest documents when cache exceeds 12 entries

## [0.2.9] - 2026-07-04

### Fixed

- Dock / bundle icon: brand dark background with accent stacked pages (matches in-app LogoMark colors)
- Logo geometry and palette centralized in `logo-mark-assets.json`; `app-icon.svg` generated from it
- Saved file paths that fail to restore on launch are pruned and surfaced via toast
- Streaming assistant replies: completed paragraphs are parsed once; only the tail re-renders during stream
- `verify-bundle-version` uses filesystem lookup instead of shell glob

### Changed

- `beforeBuildCommand` runs `icons:generate` so bundle icons stay in sync with logo assets
- `icons:generate` now regenerates `app-icon.svg` before rasterizing platform icons

## [0.2.8] - 2026-07-04

### Fixed

- About screen version now reads the macOS bundle version at runtime (matches Finder / Get Info)
- Release builds verify `Info.plist` `CFBundleShortVersionString` matches `VERSION`

### Changed

- Dock / app bundle icons regenerated to match in-app LogoMark (stacked pages + green dot, no black background)
- Tauri `version` reads from `package.json`; `beforeBuildCommand` runs `version:sync` before each build
- Added `npm run icons:generate` and `npm run verify:bundle-version` scripts

## [0.2.7] - 2026-07-04

### Fixed

- Agent tool steps: aggregate searches/tools across `reasoning` and `step-start` boundaries while preserving intro text before the tool block
- Agent streaming: yield to WebKit between tool steps; live message re-renders on part updates without full memo bypass
- API key migration: only mark Keychain migration complete when reads succeed; retry on next launch if access was denied
- Provider switch / autosave: stop rewriting Keychain when the API key did not change
- File access after restart: persist allowed paths (and parent directories) across launches; restore on startup with recent files
- Opening a document fails fast when path registration fails instead of a late opaque error
- Chat progress bar no longer overlaps when the assistant is streaming `reasoning` before text

### Changed

- File picker uses scoped access mode on macOS for better document permission handling

## [0.2.6] - 2026-07-04

### Fixed

- Agent chat stuck on「已调用工具」with no output until the end: group tool steps across agent `step-start` boundaries; show live in-progress labels and a persistent progress bar
- Agent send no longer hangs silently when API key is missing; validate key before dispatch
- API key re-entry after reinstall or provider switch: always mirror keys to local settings; read local copy first to avoid repeated macOS Keychain prompts
- Trackpad page turns on tall pages: scroll within the page before flipping at top/bottom edge

### Changed

- Tool progress during streaming: aggregate completed steps and show current action (e.g.「已搜索 2 次 · 正在搜索文档…」)
- Final answer text streams incrementally once generation starts
- `connectionVerified` no longer treated as having a stored API key when the key is actually missing

## [0.2.5] - 2026-07-04

### Fixed

- Agent chat: tool-only replies no longer show only「已调用工具」— defer history prune until stream flush; surface reasoning when no text answer
- Trackpad PDF page turns: flip on threshold instead of waiting for gesture end; faster cooldowns and instant performance rendering during swipe

### Changed

- Agent tool steps aggregated into a collapsible summary (e.g.「已搜索 6 次 · 已调用工具 1 次」) instead of stacking many chips
- Touchpad flips skip page-turn animation; keyboard navigation keeps it
- PDF preview checks page cache before async fit-width scale resolution

## [0.2.4] - 2026-07-04

### Fixed

- PDF open/preview crash in Tauri WebView (`undefined is not a function`): restore Rust text extraction on open; pdf.js used for canvas render only
- pdf.js cMap / standard font assets copied at build time; runtime URLs resolved against webview origin
- `read_file_bytes` returns `Vec<u8>` for reliable IPC byte loading
- Chat messages without `parts` normalized on load; guards against iterator errors in agent sync and rendering
- `Promise.withResolvers` polyfill for pdf.js on older WebKit builds

### Changed

- Agent page reads use Rust `extract_pdf_text_cmd` instead of pdf.js text layer
- Text selection layer disabled in Tauri desktop (preview canvas only)
- Preview error banner shows the underlying message for easier diagnosis

## [0.2.3] - 2026-07-04

### Fixed

- PDF index badge false failures: wait for pdf.js text extraction, sync docCache to UI, recover from stale failed state
- Agent 404 misreported as “model/endpoint not found” when OpenRouter lacks tool-use routes; correct error ordering
- OpenRouter VL models no longer used as agent model; auto-migrate to split agent + vision models
- Startup keychain password prompt: defer API key read until settings/agent need it
- Logo: Dock / app bundle icons regenerated to match in-app document mark (stacked pages + green dot)

### Changed

- Settings: separate **Agent model** and **Indexing model (vision)**; test connection probes tool calling
- Vision indexing uses dedicated vision model settings

## [0.2.2] - 2026-07-04

### Added

- Lazy-loaded preview and chat panels; thumbnail sidebar windowing; pdf.js lazy loader with bundled cMaps
- Byte-budget PDF page cache; quality-aware cache lookup (fixes navBurst crisp miss); render-task cancellation
- Asset-protocol PDF byte loading with IPC fallback; `renderPageToJpegBytes` for vision indexing
- `findLastMessage` helper; unit tests for message search utilities

### Changed

- PDF text extraction unified on pdf.js (no blocking Rust extract on open; agent tools use frontend extract)
- Streaming throttle 50→100 ms; skip debounced chat save while streaming; memoized hot-path components
- Rust commands async via `spawn_blocking`; OCR stdin pipeline with PNG fallback; release profile LTO/strip
- Vite manual chunks, chrome110 target, drop console in production; `image` crate slimmed features

### Fixed

- Text layer always mounted with visibility toggle; resize observer debounced/quantized
- Preview render effect deps narrowed; stale render guard; thumbnails routed through render queue

## [0.2.1] - 2026-07-04

### Security

- Backend path allowlist: file commands (read / extract / OCR / write) reject any path not authorized via `register_allowed_path`; the frontend registers document and save paths
- Agent tools validate paths against loaded documents, blocking prompt-injection reads of arbitrary local files; document filename sanitized before entering the system prompt
- Enabled a real Content-Security-Policy (`script-src 'self'`) and narrowed the asset protocol scope from `**` to `$HOME/**`
- LLM-emitted Markdown links open via the opener plugin with a scheme allowlist instead of navigating the webview; remote images constrained
- Rewrote the secret scan (git-tracked files, match-first, hyphenated key formats); keychain provider names validated

### Fixed

- API keys: keychain JSON fallback is read back and preserved across saves (fixes silent key loss without a working keychain); custom provider with an empty base URL no longer sends the key to `api.openai.com`
- PDF viewer: render queue settles on cache clear (no hung viewer), pdf.js documents are destroyed, LRU page cache, corrected `devicePixelRatio` scaling
- Document load race, drag-drop listener leak, and StrictMode double-indexing fixed; vision indexing runs in a bounded pool with abort-on-switch, timeout, 429 backoff, and no re-billing of indexed pages
- Agent: `read_pdf_range` continues over-long pages via an offset; step and character budget added; dangling tool parts stripped on save/send to preserve tool pairing
- Chat-session store mutations serialized with corrupt-store guards; `page-intent` parses Chinese / full-width numerals and ranges; Unicode-safe search and slicing
- Accessibility: IME composition guard on Enter; keyboard-operable menus, tabs, command palette, and resize handle; focus-trap visibility fix; stacked-overlay Escape handling
- Light-theme contrast, consolidated tokens, z-index scale; confirmation before deleting library sessions; composer draft restored on send failure
- i18n plural / singular keys aligned between English and 简体中文

### Changed

- `package-lock.json` / `Cargo.lock` version kept in sync and covered by the CI drift check; release workflow fails on missing artifacts or tag/version mismatch; CI now compiles the Rust backend
- Documentation corrections (README / RELEASE / SECURITY); added `license` fields

## [0.2.0] - 2026-07-04

### Added

- Redesigned v3 UI: app rail, library drawer, welcome view, settings tabs
- macOS Keychain storage for API keys (`keyring` + Tauri commands)
- Per-provider LLM profiles (LlmStoreV2) with preview / set-active flow
- Chat session persistence per document with stable document switching
- Vision indexing for sparse PDF pages and images
- i18n: English and 简体中文
- Model capability hints (vision, tool calling) in settings
- OpenRouter tool-use validation and model migration
- Vitest unit tests for settings and chat sessions
- Pre-release secret scan (`npm run check:secrets`)
- Version sync script (`VERSION` → package.json / Tauri / Cargo)
- macOS DMG bundle configuration and GitHub release workflow

### Changed

- OpenRouter default model → `openai/gpt-4o-mini` (tool-capable)
- Settings auto-save with debounced persistence
- Improved agent error messages (Chinese + English)

### Security

- API keys no longer intended for plaintext storage in `settings.json`
- Redacted settings snapshots in debounced save comparisons
- Agent errors not logged to console in production builds

## [0.1.0] - 2026-07-03

Initial public release with PDF preview, OCR, streaming document agent, and multi-provider LLM support.

[Unreleased]: https://github.com/hxddh/pagewise/compare/v0.2.25...HEAD
[0.2.25]: https://github.com/hxddh/pagewise/compare/v0.2.24...v0.2.25
[0.2.24]: https://github.com/hxddh/pagewise/compare/v0.2.23...v0.2.24
[0.2.23]: https://github.com/hxddh/pagewise/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/hxddh/pagewise/compare/v0.2.21...v0.2.22
[0.2.21]: https://github.com/hxddh/pagewise/compare/v0.2.20...v0.2.21
[0.2.20]: https://github.com/hxddh/pagewise/compare/v0.2.19...v0.2.20
[0.2.19]: https://github.com/hxddh/pagewise/compare/v0.2.18...v0.2.19
[0.2.18]: https://github.com/hxddh/pagewise/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/hxddh/pagewise/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/hxddh/pagewise/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/hxddh/pagewise/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/hxddh/pagewise/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/hxddh/pagewise/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/hxddh/pagewise/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/hxddh/pagewise/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/hxddh/pagewise/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/hxddh/pagewise/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/hxddh/pagewise/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/hxddh/pagewise/compare/v0.2.6...v0.2.7
[0.2.1]: https://github.com/hxddh/pagewise/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hxddh/pagewise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hxddh/pagewise/releases/tag/v0.1.0
