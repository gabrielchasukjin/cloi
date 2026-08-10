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

# Protocol writes must not be captured along with the code's own output, so the
# real streams are captured once, before anything is ever redirected.
PROTOCOL_OUT = sys.stdout


def reply(payload):
    PROTOCOL_OUT.write(json.dumps(payload) + "\n")
    PROTOCOL_OUT.flush()


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
    return sorted(k for k in NS if not k.startswith("_"))


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as exc:
            reply({"ok": False, "error": "bad request: %s" % exc})
            continue

        kind = msg.get("type")
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
