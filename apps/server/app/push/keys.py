"""Prints a fresh VAPID key pair: `python -m app.push.keys`."""

from app.push.vapid import generate_keys

if __name__ == "__main__":
    public, private = generate_keys()
    print("Add these lines to apps/server/.env (keep the private key secret):\n")
    print(f"VAPID_PUBLIC_KEY={public}")
    print(f"VAPID_PRIVATE_KEY={private}")
    print("VAPID_SUBJECT=mailto:you@example.com")
