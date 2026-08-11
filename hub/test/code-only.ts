// code-only.ts — reduce TypeScript source to the text that RUNS.
//
// NOT a suite (run-all.ts lists it under NON_SUITES): a shared helper, imported by the suites that
// derive a claim from the source tree. It exists because two of them must answer the same question —
// "does this name actually EXECUTE here, or does it only survive in prose?" — and a second
// implementation of that answer is a second thing to get wrong. destructive-guard.ts's coverage map
// (LOOP-305/367, four rounds of PR #271 review) is the implementation; LOOP-396's consumer inventory
// is the second caller, and extracting it here is what keeps the two from drifting apart.
//
// Its BEHAVIOUR is asserted by destructive-guard.ts's probe arms, which stayed where they are: the
// scrub is only load-bearing there in company with the map it protects, and moving the assertions
// away from the claim they guard would be the wrong half to share.

// Reduce a suite to the text that RUNS: comments and string literals hold prose, so they are
// dropped; a template SUBSTITUTION is code and is kept (`${confirmationToken(k)}` is a real call).
// A regex BODY is dropped with them (PR #271 review, fourth round): evaluating `/FIRE_MARKERS/`
// runs code, but the identifier-shaped characters in its pattern never touch the binding of that
// name — so keeping the body let a suite that deleted its last real read of a constant still read
// as covering it. The literal is consumed by its own scanner rather than left to the escape-pair
// rule, which is what keeps a `\/` inside the pattern from ending it early and a `//` inside it
// from opening a comment. Dropped constructs collapse to a space so two identifiers never fuse.
export const codeOnly = (text: string): string => {
  const stack: ("code" | "tmpl")[] = ["code"];
  const outerDepths: number[] = [];
  let depth = 0;                             // brace depth of the innermost `${…}` frame
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (stack[stack.length - 1] === "tmpl") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); out += " "; i++; continue; }
      if (c === "$" && text[i + 1] === "{") { stack.push("code"); outerDepths.push(depth); depth = 0; out += " "; i += 2; continue; }
      i++; continue;                         // template prose
    }
    if (c === "\\") { out += " "; i += 2; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; out += " "; continue;
    }
    if (c === "/") {
      // Division, or a regex literal whose body must go? `//` and `/*` are already consumed
      // above, so this `/` opens a literal only where a VALUE may start — after an operator, an
      // opening bracket, a separator or a keyword. Anywhere else it divides and is KEPT, which
      // is the safe default in only one direction: dropping real code makes the map fail loudly,
      // keeping pattern text makes it pass quietly. So the named residual is a literal opening
      // in a position this list does not carry (`if (x) /re/.test(y)` — after `)`), which still
      // reads as division; closing that needs another entry here, not a different pattern.
      const tail = out.slice(-64).replace(/\s+$/, "");
      if (tail === "" || "(,=:[!&|?{};+-*%~^<>".includes(tail.slice(-1))
        || /\b(?:return|typeof|case|in|of|new|delete|void|instanceof|yield|await|do|else)$/.test(tail)) {
        i++;                                   // past the opening slash
        let inClass = false;
        while (i < text.length) {
          const r = text[i];
          if (r === "\\") { i += 2; continue; }
          if (r === "\n") break;               // unterminated: it was never a literal
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) { i++; break; }
          i++;
        }
        while (i < text.length && /[a-z]/.test(text[i]!)) i++;   // flags
        out += " "; continue;
      }
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) { if (text[i] === "\\") i++; i++; }
      i++; out += " "; continue;
    }
    if (c === "`") { stack.push("tmpl"); i++; continue; }
    if (c === "{") depth++;
    if (c === "}") {
      if (depth === 0 && stack.length > 1) { stack.pop(); depth = outerDepths.pop() ?? 0; out += " "; i++; continue; }
      depth--;
    }
    out += c; i++;
  }
  return out;
};
