# Reference adventure: The Bell Beneath Elderglen

The authored adventure is available in `adventures/elderglen.en.json` and
`adventures/elderglen.es.json`. Both versions use the same IDs and mechanics with localized text.

The party reaches a village threatened by a rising river. Its warning bell is silent. Players can
listen to neighbors, follow clues along the bank, visit the archive or ferry, find useful items and
decide how to respond at the spillway.

## Short reproducible route

1. Go to the village green.
2. Ask Elin what the villagers need.
3. Carry the drawing to the tower stairs.
4. Test the stiff release lever.
5. Resolve the pending d20.
6. Ring the bell and warn the village.

This route reaches the warning ending with either check outcome. The dice result is real and
consumed once. Another final choice opens the spillway toward the marsh.

## Mechanics and public information

- Declared variables are bounded; effects cannot exceed their allowed range.
- Inventory gates the key/prism paths, and only owned allowed items can be used.
- Scene affordances resolve through existing authored choices, rather than model-created effects.
- Every public projection contains only the revealed scene and currently executable actions.
- The complete source templates contain authoring notes/hidden facts; these are excluded from runtime
  public turns, TV snapshots and comic exports.

`tests/fixtures/dialogues/elderglen.en.json` and `elderglen.es.json` contain synthetic conversational
evaluation cases. Engine tests explore legal states and both check outcomes. These tests measure
observable game behavior, rather than a fixed model wording or microphone quality.
