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
