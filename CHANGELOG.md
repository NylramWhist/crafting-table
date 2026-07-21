# Changelog

## 1.0.16

- Fixed an editor regression where recipe switches could present only a tiny native click target; the visible track is now fully interactive, with a 40 px touch target in mobile mode.
- Enabling an optional outcome now opens its settings immediately, while disabling it closes the section and keeps the disclosure state synchronized.
- Isolated non-critical responsive, row-control, and validation setup so a rendering fault in one helper cannot prevent the GM editor event handlers from being registered.
- Completed the shared visual system with semantic surface, paper, text, status, border, elevation, motion, spacing, radius, and typography tokens wired into the existing player, GM, preview, and launcher themes.
- Unified primary, destructive, selected, hover, active, focus, disabled, accordion, and card states while retaining reduced-motion and forced-colors behavior.
- Added non-color status icons and structured player empty states, plus 40 px mobile controls and enlarged mobile row-reordering targets.
- Added automated contrast and visual-contract checks for the core dark and paper palettes, status rendering, empty states, motion fallbacks, and mobile targets.
- Added real ingredient, result, and outcome row reordering with drag handles plus accessible Move Up/Move Down controls.
- Added a keyboard- and click-accessible native Foundry Item picker for world Items and configured Item compendiums while retaining drag and drop.
- Added crafting busy feedback with `aria-busy`, a live progress message, and duplicate-action locking for craft and work operations.
- Added field-level validation messages, invalid-field focus, and automatic disclosure of the first affected editor section.
- Introduced shared color, spacing, radius, and typography tokens, improved helper-text contrast, and raised minimum editor text sizes.
- Made player and GM layouts respond to their own ApplicationV2 window width through `ResizeObserver`, with deterministic wide, normal, compact, and mobile modes.
- Added the compact/mobile player flow from recipe browsing to details and back, including focus restoration to the selected recipe.
- Replaced the hidden narrow GM preview with an accessible Recipes/Editor/Preview workspace switcher while retaining the full three-pane wide layout.
- Replaced viewport-width media queries with application-width state and added regression coverage for 360, 480, 680, 1000, 1280, and 1520 px.
- Split the GM panel into ApplicationV2 shell, header, library, editor, preview, requests, and import/export parts, with targeted rerenders for recipe and request filters.
- Moved ingredient, result, outcome-result, and outcome-effect rows into reusable Handlebars partials and removed the corresponding JavaScript HTML-string builders.
- Unified recipe drafts and dirty state in `RecipeDraftStore`, and added a close guard that prevents silently discarding unsaved recipe changes.
- Added contract, integration, and unit coverage for GM partial rendering, row partial registration, draft state, and the unsaved-close confirmation flow.
- Split the player crafting table into ApplicationV2 shell, header, category, recipe-list, and details parts; interactions now render only the dependent parts while Foundry preserves focus and scroll state per part.
- Replaced the GM panel's manual tab state and full rerenders with native `TABS`, `tabGroups`, and `changeTab` navigation while preserving unsaved recipe drafts and accessible tab state.
- Added contract and Foundry 13/14 integration coverage for partial player renders and render-free GM tab changes.
- Updated both Foundry 13 compatibility profiles from 13.350 to the 13.351 Stable 9 security and bug-fix release while retaining D&D5e 5.0.0 as the minimum supported system.
- Added deterministic Foundry 13/14 test bootstraps that import the real module entry point and execute `init`, ApplicationV2 opening, context preparation, template rendering, and existing-window reuse.
- Exported the three ApplicationV2 classes and player/GM open functions for direct integration testing without changing the public `game.craftingTable` API.
- Split static contracts and runtime integrations into independently runnable test layers and added a release smoke-test checklist for all three compatibility profiles.
- Completed the player-template label contract for tool, proficiency, and remaining-time fields.
- Assigned per-instance ApplicationV2 identifiers to player crafting tables and outcome previews so multiple windows can coexist safely.
- Expanded recipe schema v5 with complete requirements, permissions, notes, and nested outcome contracts, including strict enum, chance, and Custom Macro validation.
- Added regression coverage for template labels, multi-instance application IDs, default/export recipe conformance, and invalid outcome rejection.
- Added responsive ApplicationV2 sizing that keeps the player table, GM panel, and outcome preview inside the current viewport and restores the preferred window size when space becomes available again.
- Reflowed player and GM layouts at tablet and narrow-window breakpoints, including recipe details, editor rows, request cards, toolbars, and outcome controls.
- Added visible keyboard focus, reduced-motion and forced-colors support, persistent focus restoration after partial renders, and arrow/Home/End navigation for GM tabs.
- Added tab, tabpanel, progressbar, status, landmark, live-region, expanded-state, pressed-state, and descriptive control semantics across all three application templates.
- Completed localization of dynamic editor rows, validation feedback, roll/chat output, generated recipe and outcome names, pagination, icon controls, and empty states.
- Changed the client module-language setting to `Automatic` by default so the player interface follows Foundry's active language, while retaining explicit English and Polish overrides.
- Extended project validation to reject runtime localization keys missing from the reference language and added focused regression tests for responsive sizing, focus restoration, keyboard navigation, localization selection, and static accessibility contracts.

## 1.0.14

- Split recipe indexing and document resolution into a dedicated `RecipeRepository`, D&D5e checks into `Dnd5eRollAdapter`, availability rules into a pure service, and compendium discovery into `CraftingPackService`.
- Build player and GM recipe lists from lightweight compendium index data and load the full recipe document only when its details or editor are opened.
- Load recipe compendium indexes in parallel, coalesce concurrent index requests, and cache resolved documents by UUID and index revision.
- Precisely invalidate only the changed compendium and its resolved document cache after Item or compendium updates.
- Build GM recipe cards without resolving every ingredient, result, and tool option on each render.
- Resolve name-based item summaries from parallel compendium indexes without loading full documents.
- Removed the private `module._source` fallback and added compatibility guards against restoring private or legacy cache access.
- Added focused regression tests for lazy document loading, cache invalidation, parallel indexes, pack discovery, availability summaries, and the D&D5e roll adapter.

## 1.0.13

- Added standard `npm test`, `npm run check`, and `npm run validate` development commands with a dependency-free Node environment.
- Added a generated CI compatibility matrix for Foundry 13.350 and 14.365 with the supported D&D5e 5.x line: 5.0.0 as the minimum and 5.3.3 as the current release.
- Validate every compatibility profile against the matching official D&D5e release manifest and the actual `D20Roll` source contracts used by crafting checks.
- Verify the public Foundry `ApplicationV2`, `HandlebarsApplicationMixin`, and `DialogV2` documentation for both supported generations.
- Run project validation and all tests on Windows and Linux with Node.js 20 and 22.
- Publish only the exact release archive that passed validation; development tools and compatibility metadata remain outside the runtime ZIP.

## 1.0.12

- Added explicit player checkboxes for optional ingredients; unselected optional materials are never consumed.
- Validate optional selections on the authoritative GM executor and preserve the exact selection through extra-time outcomes and the persistent GM decision queue.
- Prioritize required materials when multiple recipe entries can match the same Actor item and keep unavailable selected options visible so they can be deselected.
- Changed new recipes into in-memory drafts that create no world Item until the first valid save.
- Validate recipe drafts before creating missing item references and roll back every reference created by a save or duplicate attempt if the operation fails.
- Export the current draft without silently saving it or mutating world data, with a versioned JSON export envelope.
- Added regression coverage for optional-selection validation and persisted GM outcome metadata.

## 1.0.11

- Replaced hook-only `gmDecision` outcomes with a persistent, Actor-scoped GM decision queue.
- Added GM controls to apply the configured effect, resolve as success or failure, finalize without an effect, or return the craft to the player.
- Kept crafting progress and approval reservations locked while a decision is pending, preventing duplicate rolls and resource mutations.
- Made resource changes, progress, approval state, and decision state one rollback-aware finalization unit.
- Added safe resumption for configured additional-time outcomes and stable recipe lookup after document UUID changes.
- Published queued/resolved outcome hooks and added regression coverage for queue idempotency, authorization, transitions, resume metadata, and three-state rollback.

## 1.0.10

- Added recipe schema v5 with a persistent `recipeId` that survives Actor copies, compendium transfers, and JSON export/import.
- Migrated world and Actor-owned recipes, approval requests, and ongoing crafts to stable recipe identities; read-only legacy compendium recipes receive deterministic compatibility IDs.
- Removed runtime name and duration matching from progress cleanup, recipe knowledge, player-list deduplication, JSON imports with v5 IDs, and compendium synchronization.
- Restricted legacy name matching to the v5 migration and only when it resolves to exactly one recipe.
- Made crafting progress and approval completion one tested finalization unit that restores both Actor flags after a failure and requires GM review when restoration is incomplete.
- Restricted schema migration writes to Foundry's active GM.
- Added regression coverage for same-name recipe collisions, UUID changes, migration ambiguity, and finalization rollback.

## 1.0.9

- Added a server-identified module socket protocol that routes crafting mutations through Foundry's active GM.
- Added durable, Actor-scoped operation IDs with cached results, automatic response retries, payload conflict detection, and per-Actor serialization.
- Moved progress changes, approval lifecycle, craft commits, and GM request/progress actions to the authoritative executor.
- Made resource changes, progress cleanup, and approval completion one rollback-aware craft finalization path.
- Added review-required operation records when rollback or Custom Macro execution leaves an uncertain outcome; interrupted operations can be reviewed from the GM panel.
- Persisted the requesting user on approval requests and prevented another Actor owner from claiming that user's approval.
- Added socket protocol tests covering sender identity, authorization, lost responses, duplicate delivery, Actor races, interrupted operations, and uncertain failures.

## 1.0.8

- Fixed world recipes appearing twice in the player crafting view after a copy was added to the Actor inventory.
- Deduplicate recipe sources using recipe source UUID, Foundry `core.sourceId`, compendium source, and document UUID.
- Added an Actor-copy name fallback without collapsing independent world and compendium recipes that share a name.
- Raised the minimum supported D&D 5e system version to 5.0.0.
- Added automated validation and versioned GitHub Release publishing for tagged builds.

## 1.0.7

- Fixed the first save of a newly created recipe changing `No Tool Required` back to Alchemist's Supplies.
- Clear all top-level and nested tool requirement fields when no tool is selected.
- Ensure the GM tool selector has exactly one selected option and added a regression test for empty tool requirements.
- Fixed project backups so the local `.git` history is excluded from generated archives.

## 1.0.6

- Removed the empty bundled recipe compendium declaration; Crafting Table now ships without predefined recipes.
- Added client-wide Actor/recipe operation locks, resource revalidation after roll dialogs, guarded request transitions, and rollback extraction.
- Added a `processing` approval state with execution ownership so approved requests cannot be completed twice from separate open module windows.
- Enforced Actor OWNER permission for player-side mutations and GM permission for all GM panel actions.
- Split authorization, Actor flag persistence, approval request lifecycle, operation coordination, and transaction rollback into dedicated runtime services.
- Added regression tests for authorization, operation serialization, state changes, request transitions, and processing metadata.

## 1.0.5

- Moved remaining player/GM chat, confirmation dialog, and template text from hardcoded English strings to EN/PL localization keys.
- Localized player result quantity labels, manual crafting outcome chat, progress chat, recipe discard/delete confirmations, recipe browser headings, source labels, and duplicate recipe names.

## 1.0.4

- Added a cancelable `preClassifyOutcome` hook and documented the observational `classifyOutcome` contract.
- Switched open ApplicationV2 enumeration to the public `ApplicationV2.instances()` API with a compatibility fallback.
- Wired GM request search, filtering, sorting, summaries, and cleanup actions.
- Moved player crafting mode selection to world/recipe defaults with an explicit effective mode display.

## 1.0.3

- Restricted the player crafting launcher injection to real character sheets so the hammer button no longer appears in Short Rest or other actor-linked dialogs.

## 1.0.2

- Fixed Foundry 13 discovery by allowing D&D 5e system 4.x as well as 5.x.
- Added public manifest and versioned GitHub Release download URLs.
- Removed all duplicated module icon assets and switched the tool index to Foundry core icon paths.
- Reworked release packaging to use portable forward-slash ZIP entries and exclude development-only files.

## 1.0.1

- Restored the English player-panel dictionary after Polish localization values had overwritten both language tables.
- Added immediate player-panel refresh when the client module language changes.
- Added a regression test covering English and Polish player labels.

## 1.0.0

- Finalized recipe creation, native icon selection, configurable critical thresholds, permissions, progress, roll options, JSON transfer, and Custom Macro outcomes.
- Completed English and Polish localization with corrected UTF-8 text.
- Published recipe schema v4, public API v1, stable hooks, and a machine-readable JSON Schema.
- Split runtime services for rules, data, migrations, JSON, macros, Tidy integration, localization, and API contracts.
- Added the complete installation, recipe, permission, JSON, macro, migration, and API manual.
- Verified Foundry 13/14 manifest compatibility and retained private-release metadata without public download URLs.

## 0.9.18

- Introduced the frozen, versioned game.craftingTable API v1 while preserving legacy aliases.
- Published stable hook names and added API/schema versions to hook and Custom Macro contexts.
- Frozen recipe schema v4 and added its machine-readable JSON Schema document.
- Added public API contract tests.

## 0.9.17

- Split macro execution, JSON file handling, Tidy 5e integration, migrations, and player UI translations into dedicated ES modules.
- Reduced the main runtime file while preserving the player and GM application adapters.
- Added focused tests for JSON import shape extraction and export filename generation.

## 0.9.16

- Added complete English and Polish localization for the GM panel, outcome preview, settings, recipe options, and notifications.
- Corrected Polish diacritics and removed legacy mojibake from player-facing translations.
- Localized dynamic recipe outcome summaries, JSON transfer messages, macro feedback, and tool selection labels.
## 0.9.15

- Added the native Foundry image FilePicker to the recipe icon button.
- Implemented configurable custom total thresholds for critical success and critical failure.
- Removed legacy `allowLearning`, `allowDiscovery`, and ineffective `No Gold Refund` data through recipe schema v4 migration.
## 0.9.14

- Prepared the private GitHub development repository and release documentation.
- Added repository metadata and retained the repository MIT license while intentionally omitting public manifest and download URLs.

## 0.9.13

- Replaced deprecated global Foundry helpers with `foundry.utils` APIs.

## 0.9.12

- Added a native Tidy 5e Sheets character tab while preserving classic-sheet launchers.

## 0.9.11

- Made crafting progress, outcomes, approval requests, and GM decisions private to the acting player and GMs.
- Completed missing notification strings to prevent raw localization keys from appearing.

## 0.9.10

- Improved player status contrast and readability.

## 0.9.9

- Consolidated duplicated crafting application logic.
- Added versioned schema migrations and full Custom Macro outcomes.
