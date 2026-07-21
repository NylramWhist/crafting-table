# Crafting Table

Crafting Table is a Foundry Virtual Tabletop module for D&D 5e that manages recipes, ingredients, tools, crafting checks, progress, permissions, outcomes, and portable JSON transfers.

Stable builds are distributed through GitHub Releases and can be installed directly in Foundry VTT.

The module intentionally ships without predefined recipes. Recipes are created in each world or transferred with JSON and optional external compendiums.

## Compatibility

- Foundry Virtual Tabletop 13 and 14
- D&D 5e system 5.0.0 or newer
- Classic D&D 5e character sheets
- Optional native Tidy 5e Sheets tab
- English and Polish interface

## Installation

1. Close the Foundry world or return to Setup.
2. Copy the module folder to `FoundryVTT/Data/modules/crafting-table`.
3. Start Foundry and enable **Crafting Table** in **Manage Modules**.
4. Refresh the world once after an update so migrations and templates reload.

Install using this manifest URL: `https://raw.githubusercontent.com/NylramWhist/crafting-table/main/module.json`. Release ZIP files are published as GitHub Release assets.

## Opening the Module

- **GM:** use the Crafting Table scene control on the left toolbar.
- **Classic character sheet:** use the Crafting Table button injected into the sheet.
- **Tidy 5e Sheets:** use the native **Crafting Table** character tab.
- **Keyboard:** press `Alt+C` to open the table for the selected token or assigned character.

Observer access is enough to view an actor's Crafting Table. Changing progress, requesting approval, or completing a craft requires Actor OWNER permission and an active GM client to execute the operation. GM management tools remain GM-only.

## Authoritative Crafting Operations

Crafting state changes are routed through Foundry's active GM over the module socket. Each operation receives a durable ID stored on the Actor, so a lost response can be retried without consuming ingredients, currency, or tools twice. Operations for one Actor are serialized even when multiple owners or browser windows act at the same time.

If Foundry closes during an operation or a rollback cannot be completed safely, the operation is marked for review instead of being replayed. The GM panel lists these records under **Interrupted Operations**. The GM should inspect the Actor's inventory, currency, crafting progress, and approval request before marking a record as reviewed.

## Creating a Recipe

Open the GM panel and choose **Create New Recipe**.

New recipes remain in memory as unsaved drafts. No world Item or automatic item reference is created until the recipe passes validation and is saved successfully; a failed save rolls back references created during that attempt.

### Basic Information

- **Name:** displayed recipe name.
- **Category:** built-in or custom category used by filters.
- **Rarity:** common through legendary.
- **Icon:** choose a file with Foundry's native File Picker.
- **Description:** player-facing recipe description.

### Crafting Requirements

- **Tool:** choose a known D&D 5e tool, no tool, or a custom tool.
- **Ability:** ability used for the crafting check.
- **DC:** target number before world modifiers.
- **Proficiency Required:** blocks crafting when the actor lacks the selected tool proficiency.
- **Time:** total work duration in minutes, hours, days, or weeks.
- **Cost:** currency cost with denomination.
- **Mode:** automatic, GM approval, or manual.

World settings can apply a global DC modifier, time multiplier, and cost multiplier.

### Ingredients

Ingredients can be dropped from world items or compendiums, selected through the keyboard-accessible **Select item** dialog, or entered manually. Ingredient rows can be reordered by dragging their handle or with the **Move up** and **Move down** buttons.

- **Required / Optional:** required ingredients are always used; players explicitly select each available optional ingredient before crafting. An unselected optional ingredient is never consumed.
- **Quantity:** amount needed for one craft.
- **Consumed:** determines whether the item is removed.
- **Match mode:** UUID, normalized name, or crafting tag.

UUID matching is the safest option. Name matching is useful across worlds. Tag matching allows interchangeable materials that share a Crafting Table tag.

### Results

Add one or more result items by drag and drop, the **Select item** dialog, or UUID. Result and outcome rows support the same drag and keyboard reordering controls. Quantity controls normal output. Outcome rules may change output or replace it with failure items.

### Rules and Outcomes

Every finished crafting check resolves to one of:

- critical success
- success
- partial success
- failure
- critical failure

Critical thresholds can use natural d20 results, DC margins, or custom total thresholds. Partial success can reduce output or quality, increase time, consume extra materials, or request a GM decision.

Failure and critical failure can lose ingredients, create alternate items, damage a tool, request a GM decision, or execute a Custom Macro.

### Permissions

- **Visibility:** hidden or visible.
- **Knowledge Source:** globally unlocked, unlocked by tool proficiency, or known only while the actor owns the recipe item.
- **Craft Permission:** any player, actor owner, GM only, or GM approval required.

Category counters are calculated only from recipes visible to the current player.

### Notes

- **Player Notes:** visible in the player workflow.
- **GM Notes:** management-only information.

## Player Workflow

1. Open Crafting Table from the character sheet.
2. Select a known or available recipe.
3. Confirm tool, proficiency, ingredients, cost, result, and permission status.
4. For timed recipes, log work segments until progress reaches 100%.
5. Select any optional ingredients that should be used for this attempt.
6. Finish the craft and configure the D&D 5e roll dialog when it appears.
7. Apply advantage, disadvantage, or a situational bonus through the normal D&D 5e roll configuration.

While a work or crafting action is being resolved, the table exposes a visible live status, marks itself busy for assistive technology, and blocks duplicate submissions. Crafting progress and outcome messages are whispered to the acting player and GMs. Unrelated players do not receive progress notifications.

Recipe save errors are shown both in the validation summary and beside the affected fields. The editor opens the first affected section and focuses the first invalid control.

## Automatic, Approval, and Manual Modes

- **Automatic:** consumes resources and creates results after the roll.
- **GM approval:** sends a request to the GM queue before finalization.
- **Manual:** rolls and reports the outcome; the GM handles inventory changes.

The GM panel contains request filters, approval actions, ongoing crafts, a persistent outcome queue, and cleanup actions for completed records.

## GM Decision Queue

An outcome configured as **GM Decision** no longer finalizes the craft immediately. It creates a durable record in `flags.crafting-table.pendingOutcomes`, keeps the related progress and approval reservation intact, and blocks another attempt for the same Actor and stable recipe identity.

The GM can resolve the record from the **Requests** tab by choosing one concrete action:

- apply the recipe's configured outcome;
- resolve as a normal success;
- resolve through the recipe's failure rule;
- finalize without a mechanical effect;
- return the craft to the player without finalizing it.

Applying a decision updates resources, progress, the approval request, and the decision record as one rollback-aware operation. If the configured outcome adds more crafting time, the request is released and the approved outcome is stored with the ongoing craft so finishing the extra work does not create a second GM decision.

## JSON Import and Export

The **Import / Export** tab moves recipes between Foundry worlds without requiring a compendium.

### Export

- Export the current recipe.
- Select multiple recipes in the browser and export them together.
- Export all world recipes.

The module downloads one `.json` file containing recipe data and source metadata. Invalid recipes are skipped and reported.

### Import

1. Open **Import / Export**.
2. Choose **Import Recipes From JSON**.
3. Select a Crafting Table JSON file.
4. Review the imported, skipped, and invalid counts.

Import accepts Crafting Table bundles, single recipe objects, Foundry Item-shaped JSON, and arrays of supported entries. Existing world recipes with the same stable `recipeId` are skipped; legacy JSON receives a deterministic compatibility ID during import.

## Custom Macro Outcomes

A failure or critical failure can execute a world Macro. The user finishing the craft must have permission to execute that Macro.

The Macro receives one object containing:

```js
{
  actor,
  token,
  speaker,
  recipe,
  outcomeType,
  craftingTable: {
    apiVersion,
    recipeSchemaVersion,
    moduleId,
    actorUuid,
    recipeId,
    recipeUuid,
    recipeName,
    dc,
    app
  }
}
```

Return `false` or `{ cancel: true }` to keep the craft unfinished. Any other return value allows finalization.

Macro lifecycle hooks:

```js
Hooks.on("craftingTablePreExecuteMacro", context => {});
Hooks.on("craftingTablePostExecuteMacro", ({ macro, result, ...context }) => {});
```

## Public API

The stable API is available as `game.craftingTable` after `init`.

```js
game.craftingTable.apiVersion;                 // 1
game.craftingTable.recipe.schemaVersion;       // 5
game.craftingTable.recipe.schemaPath;
game.craftingTable.recipe.createDefault();
game.craftingTable.recipe.normalize(data);
game.craftingTable.recipe.validate(data, { itemName: "Example" });
game.craftingTable.open(actor);
game.craftingTable.openGm();
```

Public hook names are exposed through `game.craftingTable.hooks`:

- `preClassifyOutcome`
- `classifyOutcome`
- `resolveOutcome`
- `outcomeQueued`
- `outcomeResolved`
- `preExecuteMacro`
- `postExecuteMacro`

Outcome classification hooks have separate contracts:

```js
Hooks.on(game.craftingTable.hooks.preClassifyOutcome, classification => {
  // Called with Hooks.call before items, currency, progress, or requests are finalized.
  // Set classification.outcomeType to: success, failure, partialSuccess, criticalSuccess, or criticalFailure.
  // Return false to cancel outcome resolution and prevent later classification listeners from running.
});

Hooks.on(game.craftingTable.hooks.classifyOutcome, classification => {
  // Called with Hooks.callAll after the final outcome type is chosen.
  // This is observational; mutations are ignored by Crafting Table.
});

Hooks.on(game.craftingTable.hooks.outcomeQueued, ({ actor, recipe, outcomeType, pendingOutcome }) => {
  // Observational: a durable GM decision was added to the Actor queue.
});

Hooks.on(game.craftingTable.hooks.outcomeResolved, ({ actor, recipe, outcomeType, resolution, pendingOutcome, result }) => {
  // Observational: the GM applied or returned the queued outcome.
});
```

The compatibility aliases `recipeFlagPath`, `exampleRecipeData`, `dnd5eItemPacks`, and `rules` remain available in API v1.

## Recipe Schema and Migrations

The stable recipe schema version is **5**. Its JSON Schema is stored at `data/recipe-schema-v5.json` and exposed through `game.craftingTable.recipe.schemaPath`. The schema describes the complete nested outcome contracts, including failure results, partial-success effects, critical triggers, Custom Macro requirements, permissions, and structured requirements.

Recipe data is stored in:

```text
flags.crafting-table.recipe
```

Every recipe has a persistent `recipeId`. Copies and transfers preserve it, while the GM panel's **Duplicate** action creates a new ID. Progress and approval records use this ID instead of the recipe name or current document UUID.

On world startup, Foundry's active GM migrates world and Actor-owned recipes, crafting requests, and ongoing crafts. A legacy name fallback is used only during this migration and only for an unambiguous match. The migration version is recorded only when every document update succeeds. Incomplete recipes are reported but are not deleted.

Legacy `allowLearning`, `allowDiscovery`, and ineffective refund fields are removed during normalization. `failureData` may remain as a compatibility mirror; new integrations should use `outcomes`.

Before moving a world between major module versions, keep a Foundry world backup and the project ZIP generated for that version.

## Localization

The GM panel follows Foundry's selected language. The player interface uses the **Module language** client setting, which defaults to **Automatic** and follows Foundry. English and Polish can also be selected explicitly as per-client overrides.

Translation files are located in:

```text
lang/en.json
lang/pl.json
```

Project validation checks that English and Polish expose identical keys and that every static `CRAFTINGTABLE.*` key referenced by runtime JavaScript or Handlebars templates exists in the reference language.

## Responsive Layout and Accessibility

The player table, GM panel, and outcome preview are clamped to the available Foundry viewport. Player and GM layouts use `ResizeObserver` to respond to the width of their own ApplicationV2 window rather than the browser viewport, with wide, normal, compact, and mobile modes.

Compact and mobile player windows use a browse-to-details flow with an explicit **Back to recipes** action. Narrow GM windows expose Recipes, Editor, and Recipe Preview as reachable workspace views instead of removing the preview pane.

Keyboard and assistive-technology support includes visible focus indicators, focus restoration after filtered or partially rendered views, arrow/Home/End navigation between GM tabs, labelled regions and controls, live status updates, progressbar semantics, accordion state, reduced-motion handling, and Windows forced-colors support.

The player, GM, preview, and launcher interfaces share semantic visual tokens for surfaces, paper, text, status colors, spacing, radii, elevation, and motion. Statuses use both text and icons rather than color alone. Compact controls expand to touch-friendly targets in the mobile application-width mode, while motion effects are removed when the operating system requests reduced motion.

## Development and Validation

The runtime is split into dedicated services for rules, UI filtering, Actor state, recipe identity, recipe availability, indexed recipe storage, compendium discovery, the D&D5e roll adapter, authorization, approval requests, pending GM outcomes, operation coordination, transaction/finalization rollback, migrations, JSON files, macros, Tidy integration, localization, and public API.

### Recipe loading

Recipe browsers use the fields stored in Foundry compendium indexes. All configured recipe pack indexes are requested in parallel and concurrent renders share the same pending request. The player list calculates availability from lightweight recipe data; only the selected recipe loads its full compendium document and resolves display references. The GM browser likewise builds its paginated cards from index summaries and loads a full recipe only after the editor is opened.

Resolved recipe documents are cached by UUID and index revision. Item and compendium hooks invalidate the affected pack cache without clearing unrelated recipe indexes. Package discovery uses only public module manifest and metadata properties.

The local validation entry points are:

```text
npm test
npm run check
npm run test:contracts
npm run test:integration
npm run validate
```

CI runs the full suite on Windows and Linux with Node.js 20 and 22. A separate compatibility matrix covers:

- Foundry 13.351 with D&D5e 5.0.0, the minimum supported system;
- Foundry 13.351 with D&D5e 5.3.3;
- Foundry 14.365 with D&D5e 5.3.3.

Each compatibility job checks the selected official D&D5e tag, its `system.json`, and the real `D20Roll` source methods used by Crafting Table. It also verifies the public Foundry API documentation for `ApplicationV2`, `HandlebarsApplicationMixin`, and `DialogV2`. Foundry 13.351 is the tested runtime patch; the official versioned API pages currently identify their documentation snapshot as 13.350. The matrix is defined once in `compatibility-matrix.json` and exported to GitHub Actions by the validation tool.

Automated tests cover:

- recipe outcome classification and execution plans
- ingredient and tool matching
- player filtering and category counts
- request and ongoing-craft normalization
- pending-outcome idempotency, transitions, and resume metadata
- Actor/GM authorization and operation locking
- resource-change detection and guarded request transitions
- JSON import shapes and filenames
- public API compatibility and immutability
- real entry-point import, `init` hooks, ApplicationV2 context preparation, basic template rendering, and window reuse in Foundry 13/14 test bootstraps
- responsive window sizing, keyboard focus restoration, tab navigation, and template accessibility contracts
- core dark/paper palette contrast, semantic status icons, empty states, reduced-motion behavior, and mobile control targets
- localization parity, automatic Foundry-language selection, and referenced-key validation

Foundry's licensed runtime is not downloaded by public CI. Manual Foundry testing is therefore still required for sheet injection, drag and drop, roll dialogs, permissions, and live world migrations; the bootstrap tests execute the module entry point but are not a claim that a Foundry world was booted. Use the [Foundry smoke-test checklist](docs/smoke-test-checklist.md) before publishing a release.

## License

Crafting Table is licensed under the [MIT License](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for release history.
