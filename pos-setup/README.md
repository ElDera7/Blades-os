# Setting up a BladeOS till (Licon all-in-one and similar Windows terminals)

About 20 minutes per till. Everything below is done once.

## What's supported

| Device | How it connects | Notes |
|---|---|---|
| Receipt printer (80 mm or 58 mm thermal, e.g. Licon LP100) | USB through the BladeOS printer helper (Windows), or direct from the browser | Found automatically; repaired and tested by the till setup |
| Receipt printer on a COM port | USB-serial, RS-232 or Bluetooth (shows as COMx) | BladeOS sends ESC/POS itself: auto-cut, QR code, drawer kick |
| Cash drawer | RJ11 cable into the receipt printer | Opens through the printer (driver setting, or ESC/POS mode) |
| Barcode scanner (1D/2D, USB or Bluetooth, e.g. NETUM A5) | Acts as a keyboard | No driver. Enter, Tab or no suffix all work. Presentation scanners: set the same-code delay to about 1 s |
| Label scale (prints barcode stickers) | Not connected | Scan its labels: EAN-13 starting with 2 (PLU + weight or price) |
| Counter scale on USB/COM | Web Serial | Optional; weight appears in the weigh screen |
| Customer screen (second display) | HDMI / built-in second panel | Shows items, total and change |

Not supported from a browser: network (LAN/Wi-Fi IP) receipt printers without a Windows driver. Install the maker's Windows driver for those and use the Windows-printer mode.

## 1. Windows

1. Install **Google Chrome** (Microsoft Edge also works).
2. Install the receipt printer's Windows driver from the maker's CD or website (Licon terminals usually ship an Xprinter-type 80 mm printer; use the driver in the box).
3. **Settings → Bluetooth & devices → Printers & scanners**: turn **off** "Let Windows manage my default printer", then set the receipt printer as **default**.
4. Printer **Printing preferences**:
   - Paper: **80 mm × receipt** (or 72 mm × 297 mm), margins 0.
   - **Cash drawer: Open before printing** (Drawer 1 / pin 2). On some drivers this is under *Device settings* or *Peripheral*.
   - Cutter: cut after each page.
5. **Settings → Display**: note the main screen's resolution (e.g. 1366 × 768). The customer screen should be arranged to the **right** of the main screen.

## 2. Desktop icon, printer repair and test (one download)

1. On the till, open BladeOS in Chrome or Edge and sign in (any account, e.g. the cashier).
2. Account menu (top right) → **Desktop icon** → **Download till icon (Windows)**.
3. Switch the LP100 on, load paper, and plug its USB cable into the till itself (not a hub).
4. Open **BladeOS-Till-Setup** from Downloads. If Chrome asks, choose **Keep**; if Windows says "Windows protected your
   PC", click **More info → Run anyway**. When Windows asks to allow changes (printer repair), click **Yes**.
5. It then, by itself:
   - finds the receipt printer and puts it on the USB port it's really plugged into (the usual reason receipts sit
     in the queue and never print), or creates it if Windows never did; clears stuck jobs, restarts the print
     spooler, sets it online and makes it the default printer;
   - installs the **BladeOS printer helper** (starts with Windows, works only for the BladeOS address, only on this
     computer) — receipts go straight to the printer as ESC/POS: cut, QR code, cash drawer, no print dialog;
   - **prints a test receipt** and checks it left the queue; checks the barcode scanner (e.g. NETUM A5);
   - adds the **BladeOS POS** icon (Desktop and Start menu). Answer **Y** to open BladeOS when the till starts.
6. If it says the test receipt is stuck: check power, paper, the lid and the cable, then run the file again — it's
   safe to run as often as needed.
7. The icon opens the POS full screen, and the customer screen on the second monitor if there is one. Sign in once.
   If Chrome asks to let BladeOS use devices on this computer, click **Allow**. (Alt+F4 closes the till window.)
8. Each cashier sets an **Offline PIN** once on this till: account menu → *Offline PIN (this till)*.
9. POS → **Devices**: set the **Till number** (1, 2, …) — it starts the receipt numbers used offline (T1-000123).

`BladeOS-POS.bat` in this folder does the same by hand (edit the address and screen width, then `BladeOS-POS.bat install`).

Back-office PCs, laptops and phones don't need the launcher: open BladeOS in Chrome or Edge and use the account menu →
**Install BladeOS app** (or the install icon in the address bar; on a phone, *Add to Home screen*).

## 3. In BladeOS (POS → Devices)

1. **Receipt printer** is found automatically — the POS header shows **Printer: ready ✓** (through the BladeOS printer
   helper), or **USB ✓** / **COM ✓** (direct from the browser), or **Windows** (browser printing, the fallback).
   - Red **Printer: 2 waiting** / **Printer offline**: receipts are stuck in the Windows queue. Devices → **Clear stuck
     receipts**, check power, paper and cable, then **Print test page**. Still stuck: run BladeOS-Till-Setup again.
   - Without the helper (not a Windows till): Devices → **Find printer** lists every USB device — pick the printer.
   - **Print test page** and **Open cash drawer** to check.
2. Leave *Connected as* on **Find automatically**.
3. **Barcode scanner**: nothing to set up. Scan any product at the POS: the header turns to **Scanner ✓**. (Devices → scanner test box shows the details.) Scan a scale label: it should name the product and weight.
4. **Customer screen**: if it didn't open on its own, press *Customer screen* on the POS, allow window placement, or drag it to the second display and press F11.
5. Business Setup → Products: scan each packed product's barcode into its **Barcode** box. Business Setup → Receipt & Till: address, phone, TIN, and whether your label scale prints **weight** or **price**.

## When the internet goes down

- The till keeps selling: cash, card and transfer sales, receipts, the cash drawer, scanner, scale and customer screen all
  carry on. A yellow bar says **Offline** and how many items are waiting to upload.
- Offline receipts are numbered **T1-000001**, **T1-000002**, … (T + till number). Each one becomes a normal ORD number
  when it uploads.
- Also saved for upload: cleared tickets, temperature readings and food-safety checklists. Tickets can be held and recalled.
- Needs the internet: manager-approved discounts, pay-later, new customers, refunds, approvals, reports, closing the till.
- If the till restarts without internet, sign in with the **Offline PIN**. Five wrong tries remove the PIN.
- After **24 hours** offline the bar turns red; after **72 hours** selling pauses until the till uploads.
- When the internet is back, sign in normally: everything uploads by itself. A manager signing in on the till also uploads
  sales left by a cashier who has gone home.
- Uploaded sales keep the time they were made and the price the customer paid. If the system had less stock than was
  sold, or a price had changed, the sale is still recorded and managers see a "check" note on the order.
- **Never clear the browser data on a till** while the bar shows items waiting. To be safe before reinstalling Windows,
  tap the bar → *Save a copy (file)*.

## 4. Check before opening

- A cash sale prints one receipt, cuts, and opens the drawer.
- A card or transfer sale prints and does **not** open the drawer (ESC/POS mode; in Windows-printer mode the driver opens it on every receipt unless you pick "Cash only" where the driver offers it).
- The customer screen shows each item, the total, and the change.
- Close the till and print the Z report.
- Unplug the network cable (or turn off Wi-Fi), make a sale, plug it back in, sign in: the bar should say everything uploaded.

## Troubleshooting

| Problem | Fix |
|---|---|
| Receipts queue in Windows but never print | Run BladeOS-Till-Setup again (account menu → Desktop icon): it moves the printer to the right USB port, clears the queue and prints a test |
| Print dialog appears / header says Printer: Windows | The printer helper isn't running: open BladeOS from the **BladeOS POS** icon (it starts the helper), or run BladeOS-Till-Setup again |
| Find printer shows nothing | On a Windows till use the helper instead (BladeOS-Till-Setup). Windows' printer driver keeps the USB port to itself, so browsers can't see it |
| Receipt prints tiny or on A4 | Receipt printer isn't the default, or paper size isn't set to 80 mm in Printing preferences |
| Drawer doesn't open | Drawer cable must go into the printer's DK/RJ11 port; enable "open cash drawer" in the driver |
| Scanner types into the wrong box | Click the POS search box once, or close any open dialog; scanned codes always go to the search box when nothing else is focused |
| Scale labels say "bad check digit" | Clean the label or scanner window; reprint the label |
| Scale labels give the wrong weight | Business Setup → Receipt & Till → *Scale labels carry*: weight or price |
| Customer screen blank | It shows "Welcome" when no sale is in progress. It must be opened from the same till (same launcher) |
