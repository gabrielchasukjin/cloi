"""Persistent Python kernel driver.

Reads one JSON request per line from stdin, writes one JSON response per line to
stdout. The namespace lives for the life of the process, which is the whole
point: a variable bound in one call is still there in the next.

Deliberately small. A Jupyter kernel would bring a dependency, a wire protocol
and a discovery dance for what is, at this level, `exec` against a dict that
never goes away.
"""

import ast
import contextlib
import io
import json
import sys
import traceback

# The persistent namespace. Everything the agent defines lands here and stays.
NS = {"__name__": "__cloi__", "__builtins__": __builtins__}

# Names the host installed. Reported separately from the agent's own variables:
# listing ten tool functions after every cell is noise, and the agent knows they
# are there because it was told.
INSTALLED = set()

# Source of every function and class the agent defined, by name.
#
# pickle serialises a function by reference, not by value, so a helper defined
# in a cell cannot be saved — and a helper the agent wrote is exactly the kind
# of thing worth keeping. Its source is replayed on restore instead.
DEFS = {}

# Protocol writes must not be captured along with the code's own output, so the
# real streams are captured once, before anything is ever redirected.
PROTOCOL_OUT = sys.stdout


def reply(payload):
    PROTOCOL_OUT.write(json.dumps(payload) + "\n")
    PROTOCOL_OUT.flush()


def read_message():
    """One request line.

    `sys.stdin.readline()` rather than iterating stdin: the iterator reads ahead
    into a private buffer, which would swallow the reply to a tool call made
    from inside a running cell.
    """
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    return json.loads(line) if line else {}


class ToolError(RuntimeError):
    """A tool ran and reported a failure. Catchable like any other exception."""


def call_host(tool, kwargs):
    """Run one of cloi's tools and return its output as a string.

    Synchronous on purpose. The kernel is single-threaded and the host answers
    one call at a time, so `text = read_file(path='a.js')` reads exactly like
    the function call it appears to be.
    """
    reply({"type": "call", "tool": tool, "args": kwargs})
    message = read_message()
    if message is None:
        raise ToolError("cloi closed the connection")
    if not message.get("ok"):
        raise ToolError(message.get("error") or ("%s failed" % tool))
    return message.get("output", "")


def install_tools(names):
    """Bind each tool as a plain function in the namespace."""
    for name in names:
        def make(tool_name):
            def call(**kwargs):
                return call_host(tool_name, kwargs)
            call.__name__ = tool_name
            call.__doc__ = "cloi tool %r. Keyword arguments only; returns its output as a string." % tool_name
            return call
        NS[name] = make(name)
        INSTALLED.add(name)
    NS["ToolError"] = ToolError
    INSTALLED.add("ToolError")


def run(code):
    out, err = io.StringIO(), io.StringIO()
    value = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            # The *last* statement, not the whole cell, decides whether there is
            # a value. Compiling the cell as an expression only works when it is
            # a single line, so a cell that built a list and then named it
            # returned nothing — which is not how a notebook behaves, and not
            # what the tool description promises.
            tree = ast.parse(code, "<cell>", "exec")
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    segment = ast.get_source_segment(code, node)
                    if segment:
                        DEFS[node.name] = segment
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                head = ast.Module(body=tree.body[:-1], type_ignores=[])
                tail = ast.Expression(body=tree.body[-1].value)
                exec(compile(head, "<cell>", "exec"), NS)
                value = eval(compile(tail, "<cell>", "eval"), NS)
            else:
                exec(compile(tree, "<cell>", "exec"), NS)
        return {
            "ok": True,
            "stdout": out.getvalue(),
            "stderr": err.getvalue(),
            "value": None if value is None else repr(value),
        }
    except BaseException as exc:  # SystemExit and KeyboardInterrupt included
        return {
            "ok": False,
            "stdout": out.getvalue(),
            "stderr": err.getvalue(),
            # Only the final frame: a traceback through this driver's own stack
            # tells the agent nothing about its code.
            "error": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
        }


def names():
    return sorted(k for k in NS if not k.startswith("_") and k not in INSTALLED)


# Tool functions are reinstalled on every start and stored handles are rebound
# from the database, so snapshotting either would only restore a stale copy over
# a fresh one.
def snapshot(path, max_bytes):
    import builtins as _b
    import os
    import pickle
    import types

    payload = {}
    # Modules cannot be pickled, but they do not need to be: the name is enough
    # to import them again. Without this an `import re` in one session is gone
    # in the next, which is the commonest thing a namespace holds.
    modules = {}
    skipped = []
    total = 0

    for name in names():
        value = NS[name]
        if isinstance(value, types.ModuleType):
            modules[name] = value.__name__
            continue
        # A definition is saved as source below. Attempting to pickle it first
        # would report it as skipped and saved at once, which reads as a bug.
        # The type check matters: `rate = 5` after `def rate(...)` is a value
        # now, and must be pickled rather than restored as the old function.
        if name in DEFS and isinstance(value, (types.FunctionType, type)):
            continue
        # Per variable, not the whole namespace at once: an open file or a
        # socket would otherwise take every other variable down with it.
        try:
            blob = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
        except _b.Exception as exc:
            skipped.append({"name": name, "reason": _b.type(exc).__name__})
            continue
        if _b.len(blob) > max_bytes or total + _b.len(blob) > max_bytes:
            skipped.append({"name": name, "reason": "too large"})
            continue
        payload[name] = blob
        total += _b.len(blob)

    # Only definitions still present in the namespace; one the agent deleted or
    # overwrote with a value should not come back.
    live_defs = {n: src for n, src in DEFS.items() if n in NS and n not in payload}

    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with _b.open(tmp, "wb") as handle:
            pickle.dump({"vars": payload, "modules": modules, "defs": live_defs}, handle, protocol=pickle.HIGHEST_PROTOCOL)
        # Replaced, never written in place: a crash mid-write would otherwise
        # leave a truncated file that fails to load on the next run.
        os.replace(tmp, path)
    except _b.Exception as exc:
        try:
            os.remove(tmp)
        except _b.Exception:
            pass
        return {"ok": False, "error": "%s: %s" % (_b.type(exc).__name__, exc)}

    return {
        "ok": True,
        "saved": _b.sorted(_b.list(payload) + _b.list(modules) + _b.list(live_defs)),
        "skipped": skipped,
        "bytes": total,
    }


def restore(path):
    import builtins as _b
    import importlib
    import os
    import pickle

    if not os.path.exists(path):
        return {"ok": True, "restored": [], "failed": []}

    try:
        with _b.open(path, "rb") as handle:
            payload = pickle.load(handle)
    except _b.Exception as exc:
        # A corrupt or unreadable snapshot must not stop the kernel starting.
        return {"ok": True, "restored": [], "failed": [{"name": "(file)", "reason": _b.str(exc)[:120]}]}

    restored = []
    failed = []

    for alias, module_name in (payload or {}).get("modules", {}).items():
        try:
            NS[alias] = importlib.import_module(module_name)
            restored.append(alias)
        except _b.Exception as exc:
            failed.append({"name": alias, "reason": _b.type(exc).__name__})

    for name, blob in (payload or {}).get("vars", {}).items():
        try:
            NS[name] = pickle.loads(blob)
            restored.append(name)
        except _b.Exception as exc:
            failed.append({"name": name, "reason": _b.type(exc).__name__})

    # Definitions last: a helper that closes over a restored value needs that
    # value to exist first.
    for name, source in (payload or {}).get("defs", {}).items():
        try:
            exec(compile(source, "<restored>", "exec"), NS)
            DEFS[name] = source
            restored.append(name)
        except _b.Exception as exc:
            failed.append({"name": name, "reason": _b.type(exc).__name__})

    return {"ok": True, "restored": _b.sorted(restored), "failed": failed}


def main():
    while True:
        try:
            msg = read_message()
        except ValueError as exc:
            reply({"ok": False, "error": "bad request: %s" % exc})
            continue
        if msg is None:
            return
        if not msg:
            continue

        kind = msg.get("type")
        if kind == "tools":
            install_tools(msg.get("names") or [])
            reply({"ok": True, "installed": sorted(msg.get("names") or [])})
            continue
        if kind == "snapshot":
            reply(snapshot(msg.get("path"), msg.get("maxBytes") or 32 * 1024 * 1024))
            continue
        if kind == "restore":
            reply(restore(msg.get("path")))
            continue
        if kind == "bind":
            NS.update(msg.get("vars") or {})
            reply({"ok": True, "bound": sorted((msg.get("vars") or {}).keys())})
        elif kind == "names":
            reply({"ok": True, "names": names()})
        elif kind == "exec":
            result = run(msg.get("code") or "")
            result["names"] = names()
            reply(result)
        else:
            reply({"ok": False, "error": "unknown request type %r" % kind})


if __name__ == "__main__":
    main()
