// Generated from agentlas_desktop/electron/runtime/prompt-order.ts; canonical source sha256 29d98ab665013a305795ab2355b9c3de49e75c2dfe22da130ec6cc1c545221d5.
// Dependency-free Terminal reuse. Regenerate on canonical API changes; never hand-edit this copy.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptContextCollector = exports.PROMPT_ORDER_REVISION = void 0;
exports.orderPromptParts = orderPromptParts;
exports.registerDeclaredPromptModule = registerDeclaredPromptModule;
exports.declaredPromptModules = declaredPromptModules;
exports.composeDeclaredPrompt = composeDeclaredPrompt;
/** Bump when lifetime precedence changes; manifests can distinguish reordered delivery from content edits. */
exports.PROMPT_ORDER_REVISION = 1;
const STABILITY_ORDER = {
    "fixed-policy": 0,
    "versioned-content": 1,
    configuration: 2,
    "task-context": 3,
    "turn-context": 4,
    // A closing authority guard must remain after even untrusted/updated instructions.
    "final-boundary": 5,
};
/** A stable sort of declared fields. No text parsing, hashing, omission or authority changes. */
function orderPromptParts(parts) {
    return parts.map((part, index) => ({ part, index })).sort((a, b) => STABILITY_ORDER[a.part.stability] - STABILITY_ORDER[b.part.stability]
        || (a.part.order ?? 0) - (b.part.order ?? 0)
        || a.index - b.index).map(({ part }) => part);
}
const declaredModules = new Map();
/** Registration contains only host-authored metadata; prompt data and secrets are never retained here. */
function registerDeclaredPromptModule(part) {
    if (!part.id.trim() || !part.changeTriggers.length)
        throw new Error("prompt-module-declaration-required");
    const declaration = { id: part.id, revision: part.revision ?? 1, stability: part.stability,
        changeTriggers: [...part.changeTriggers], order: part.order ?? 0 };
    // A producer ID can have declared mode variants; each variant has a deterministic registry key.
    const key = JSON.stringify(declaration);
    if (!declaredModules.has(key))
        declaredModules.set(key, Object.freeze(declaration));
}
function declaredPromptModules() { return [...declaredModules.values()]; }
/** Order only host-declared lifetimes within one authority channel; never reorder conversation messages. */
function composeDeclaredPrompt(parts, separator = "\n\n") {
    for (const part of parts)
        registerDeclaredPromptModule(part);
    return orderPromptParts(parts).map((part) => part.text).filter((text) => Boolean(text?.trim())).join(separator);
}
/** Keep producer slots stable until dispatch refresh, then order only at serialization. */
class PromptContextCollector {
    parts = [];
    declarations = [];
    add(id, stability, changeTriggers, text, order) {
        if (this.declarations.some((part) => part.id === id))
            throw new Error(`prompt-context-duplicate:${id}`);
        const index = this.parts.length;
        this.parts.push(text);
        const declaration = { id, stability, changeTriggers, ...(order === undefined ? {} : { order }) };
        registerDeclaredPromptModule(declaration);
        this.declarations.push(declaration);
        return index;
    }
    compose(refreshed = this.parts) {
        if (refreshed.length !== this.declarations.length)
            throw new Error("prompt-context-undeclared-slot");
        return composeDeclaredPrompt(this.declarations.map((part, index) => ({ ...part, text: refreshed[index] })));
    }
    manifest(refreshed = this.parts) {
        if (refreshed.length !== this.declarations.length)
            throw new Error("prompt-context-undeclared-slot");
        return orderPromptParts(this.declarations.map((part, index) => ({ ...part, text: refreshed[index] })));
    }
}
exports.PromptContextCollector = PromptContextCollector;
