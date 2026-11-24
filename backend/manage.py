"""
Admin tasks you run on the server's own computer, not from the browser.

    py manage.py create-user alice    # create an account (asks for a password)
    py manage.py make-admin alice     # give alice admin rights
    py manage.py remove-admin alice   # take them away
    py manage.py set-password alice   # choose a new password for alice
    py manage.py users                # list every account
    py manage.py rooms                # list every room and its members

Making admins only from here means nobody can give themselves admin rights
through the chat page: you need access to the server itself.
"""
import argparse
import getpass

import auth
import db


def ask_new_password():
    """
    Ask for a password twice. getpass hides what you type, so the password
    never shows on screen or ends up in your terminal history.
    Returns None if it's too short or the two don't match.
    """
    password = getpass.getpass("Password: ")
    error = auth.check_password(password)
    if error:
        print(error)
        return None
    if password != getpass.getpass("Type it again: "):
        print("The two passwords don't match.")
        return None
    return password


def main():
    parser = argparse.ArgumentParser(description="Chat server admin tasks")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-user", help="create an account").add_argument("username")
    commands.add_parser("make-admin", help="give a user admin rights").add_argument("username")
    commands.add_parser("remove-admin", help="take admin rights away").add_argument("username")
    commands.add_parser("set-password", help="choose a new password for a user").add_argument("username")
    commands.add_parser("users", help="list every account")
    commands.add_parser("rooms", help="list every room and its members")
    args = parser.parse_args()

    db.init_db()

    if args.command == "create-user":
        error = auth.check_username(args.username)
        if error:
            print(error)
            return
        password = ask_new_password()
        if password is None:
            return
        if db.create_user(args.username, auth.hash_password(password)) is None:
            print(f"{args.username} already has an account.")
        else:
            print(f"Account created for {args.username}.")

    elif args.command in ("make-admin", "remove-admin"):
        make = args.command == "make-admin"
        if db.set_admin(args.username, make):
            print(f"{args.username} is {'now' if make else 'no longer'} an admin.")
            print("They get the change the next time they log in or reload the page.")
        else:
            print(f"No user called {args.username!r}. Create the account first with create-user.")

    elif args.command == "set-password":
        password = ask_new_password()
        if password is None:
            return
        if db.set_password(args.username, auth.hash_password(password)):
            print(f"Password changed. {args.username} has been logged out everywhere.")
        else:
            print(f"No user called {args.username!r}.")

    elif args.command == "users":
        for u in db.list_users():
            role = "admin" if u["is_admin"] else "user"
            print(f"{u['id']:>4}  {u['username']:<20} {role:<6} joined {u['created_at']}")

    elif args.command == "rooms":
        for r in db.all_rooms_with_members():
            who = "everyone" if r["public"] else (", ".join(r["members"]) or "no members yet")
            print(f"#{r['name']:<20} {'public ' if r['public'] else 'private'}  {who}")


if __name__ == "__main__":
    main()
