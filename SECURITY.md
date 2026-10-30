# Security

django-admin-repl gives an admin user an interactive Python process on your server. Its security model is
documented in the README's [Security](README.md#security) section: only active superusers, only their own
session, server-chosen commands, and operating-system containment as the real boundary.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/dmmeteo/django-admin-repl/security/advisories/new) for this
repository, not in a public issue. Include the version or commit, your Django, Channels and ASGI server versions,
and steps to reproduce.

In scope: anything that lets someone who is not an active superuser reach a REPL process, its output or its
controls; a way to make the server run a command or path chosen by the browser; one superuser reaching another
superuser's session; a session that outlives logout, deactivation or its idle limit.

Out of scope: what an authorized superuser can do inside their own REPL. That is the product.
