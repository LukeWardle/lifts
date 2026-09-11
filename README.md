# Lifts

The phone half of a weight-training tracker. It holds your next few workouts,
logs what you actually did with no signal at all, and hands the results back as
one block of text you can email to yourself.

The half that thinks — the progression rules, the plan for the year, the
exercise library — runs on a laptop and is not in this repository. This is the
screen you take to the gym.

## Why it works this way

A gym is a bad place to depend on a server. The basement has no signal, and the
laptop at home may be asleep. So nothing here talks to a server at all:

1. **The plan arrives in a link.** The laptop packs the next few workouts into
   the part of a URL after the `#`, which a browser never sends anywhere. You
   tap the link, and the plan is on your phone.
2. **You train offline.** Sets, cardio and weigh-ins are saved in the phone's
   own storage.
3. **The results go back as text.** One button builds a message: a readable
   summary, then the same data as a compressed block. Email it to yourself and
   the laptop reads it.

Nothing personal is stored in this repository. It only holds the app's code.

## Installing it on Android

1. Open the site in **Chrome**.
2. Tap **⋮** → **Add to home screen** → **Install**.

Chrome turns it into a real app: its own icon in the app drawer, no browser bar,
and it opens with no signal. Samsung Internet can install it too, but it keeps
its own separate storage, so use whichever one you tap plan links in.

On iPhone, use Share → **Add to Home Screen** in Safari. That path is untested.

## Using it

**Train.** Pick the workout, answer how ready you feel, then work down the
exercises. Each set has a weight, reps, and how many reps you had left. Tick a
set to record it — ticking with the boxes empty means you did exactly what was
written. Ticking starts the rest timer, which keeps the screen awake.

If a machine is taken, tap **Machine taken? Swap…**. You can search your whole
exercise list, or type in something the list has never heard of; it joins your
list on the laptop when you send your results.

**Cardio.** Log the machine, the minutes and what the console was set to. It
shows what you set last time so you can nudge one thing up.

**Body.** Weigh-ins, and a photo check-in that shares your photos out to
whatever app you like.

**Send.** Email, share or copy the results. Sending twice is safe: the laptop
keys every set to its workout, so nothing is ever counted twice.

## Where your data lives

- The plan and everything you log stay in this phone's browser storage.
- Plan links carry your plan in the `#` fragment, which is never sent to the
  web server. The site itself only ever serves code.
- Your email address, if you save one, stays on the phone.
- Nothing is sent anywhere until you press a button that sends it.

Browser storage is not a backup. Clearing the site's data, or Android reclaiming
space, loses anything not yet sent — so send your results after a session
rather than letting several build up.

## Limits

- One phone at a time. Two phones logging the same workout would each send their
  own version, and the second import would overwrite the first.
- The app cannot tell you it has an old plan. If a newer link has been sent, the
  phone keeps showing the last one you opened until you open the new one.
- Rest timers and the "training day runs to 04:00" rule use the phone's clock.
- Photos are never stored by the app: they go straight into the share sheet.

## The files

| File | What it is |
|---|---|
| `index.html` | The shell: the four tabs, the rest timer bar |
| `app.js` | Everything the app does |
| `style.css` | Styling, light and dark |
| `sw.js` | The service worker that makes it work offline |
| `manifest.webmanifest` | What makes Android treat it as an app |
| `icon-*.png` | App icons |

Updating it means replacing these files and bumping `CACHE` in `sw.js`, which is
how a phone knows to fetch the new version.
