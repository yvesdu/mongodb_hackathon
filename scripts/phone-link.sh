#!/bin/bash
# Point the sign's QR code and the owner's approve link at this laptop's address on the local Wi-Fi.
# Run it again whenever the laptop's address changes.
cd "$(dirname "$0")/.."
LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1)
CK=$(grep '^COUNTER_KEY=' .env | cut -d= -f2)
OK=$(grep '^OWNER_KEY=' .env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:8787/api/config -H "x-key: $CK" -H "content-type: application/json" -d "{\"public_url\":\"http://$LAN:8787\"}"
echo
echo "Menu for phones:      http://$LAN:8787/menu"
echo "Owner's approve page: http://$LAN:8787/approve?key=$OK"
echo "Sign, the product (this laptop):    http://127.0.0.1:8787/sign"
echo "Counter, the control (this laptop): http://127.0.0.1:8787/counter?key=$CK"
