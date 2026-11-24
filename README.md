# Polam Direct · పొలం డైరెక్ట్

A marketplace where farmers sell straight to consumers, with no middlemen and 0% commission.
The interface is in Telugu by default, with English and Hindi.

## Run

```bash
node server.js          # needs Node 22.13+ (uses built-in node:sqlite), no npm install
# open http://127.0.0.1:3000
```

The first run creates `data/market.db` and loads demo data. Delete the `data/` folder to start again from scratch.

## Demo accounts (password: `demo1234`)

| Role | Mobile | Name |
|---|---|---|
| Farmer | 9000000001 | Venkata Ramaiah (Guntur) |
| Farmer | 9000000002 | Lakshmi Devi (East Godavari) |
| Farmer | 9000000003 | Srinivasa Reddy (Anantapur) |
| Farmer | 9000000004 | Padmavathi (Annamayya) |
| Consumer | 9000000009 | Anil Kumar (Visakhapatnam) |

## Features

- **Two kinds of account.** Farmers and consumers sign up with a mobile number and password. Passwords are hashed with scrypt, and sessions use HttpOnly cookies.
- **Farmers** list produce at their own price, from a three-language catalog of 39 items or with a custom name. While listing, they see the platform's average and lowest price for that item. They accept, reject, dispatch and deliver orders, and track their earnings.
- **Consumers** search in any language (for example "టమాటా", "tomato" or "टमाटर"), filter by category, district or organic, and see a "best price" badge and the platform average. A cart can hold items from several farmers; checkout splits it into one order per farmer. They choose pickup or home delivery, and pay cash or UPI on delivery.
- **Stock** is reserved when an order is placed and returned if the order is cancelled or rejected.

## Not included yet

- SMS OTP login (needs an SMS provider)
- An online payment gateway
- Product photos (emoji are used for now)
- Ratings
