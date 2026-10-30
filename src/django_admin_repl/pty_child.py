import fcntl
import sys
import termios


def main(argv: list[str]) -> None:
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    from django.core.management import execute_from_command_line

    execute_from_command_line(["django-admin", *argv])


if __name__ == "__main__":
    main(sys.argv[1:])
