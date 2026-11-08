// ee.mjs — the hand-rolled serializer for Earth Engine Value API expressions.
//
// The football: Plotline ships with zero dependencies, so there is no EE client
// library to compile expressions. The REST `value:compute` endpoint accepts a
// serialized expression tree instead, where every node is a variant object:
//
//   { functionInvocationValue: { functionName, arguments: { name: argNode } } }
//   { constantValue: anyJsonPrimitive }
//   { valueReference: '<nodeId>' }   — a link to another entry in `values`
//
// and every function argument must be one of those variants, not a bare value.
// Note the trap this module fixes: nested invocations are NOT inlined as
// objects — EE refused them with `Unknown name "functionName"` (caught live);
// they are separate `values` entries referenced by id.
//
// One graph per request: the builder hands out node ids and lets a caller
// choose the root, because the root is usually invoked long after the inputs.

export function eeGraph() {
  const nodes = {};
  function invoke(functionName, args = {}) {
    const id = String(Object.keys(nodes).length);
    nodes[id] = { functionInvocationValue: { functionName, arguments: args } };
    return id; // pass through ee.ref(id) to use it as an argument
  }
  const ref = (id) => ({ valueReference: String(id) });
  const constant = (v) => ({ constantValue: v });
  return { nodes, ref, constant, invoke };
}
