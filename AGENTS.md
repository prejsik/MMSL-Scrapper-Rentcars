# Zasady dla agentów (Codex i Claude Code)

Ten plik czytają oba narzędzia; `CLAUDE.md` tylko go importuje. Repozytorium jest publiczne. To jedyne aktualne źródło RentCars; kopia w repo `discovercars-tool` jest nieaktualna.

## Co uruchamia scalenie

- Automaty startują z `main`: „RentCars daily run” (10:17 i 19:17) i „RentCars daily watchdog”. „RentCars morning status” działa tylko na ręczne uruchomienie.
- Punktualny start 10:17 i 19:17 dają timery systemd na serwerze OVH (`ops/ovh/`, instalacja `ops/ovh/install.sh`). Harmonogram GitHuba (opóźniony o kilka godzin) zostaje jako zapas; drugi start tej samej pory kończy się bez scrapowania. Zmiana plików w `ops/ovh/` działa dopiero po ponownym `ops/ovh/install.sh` na serwerze. Publikują raport na GitHub Pages i wysyłają podsumowanie na Telegram. Scalona zmiana działa od najbliższego przebiegu.
- `gh workflow run` uruchamiaj tylko na wyraźną prośbę.

## Testy

- Lokalnie: `npm test`.
- „RentCars push smoke” startuje dopiero po scaleniu do `main`, więc PR nie ma testów na GitHubie i o scaleniu decyduje `npm test` uruchomiony lokalnie; podaj jego wynik w opisie PR. Po scaleniu sprawdź wynik smoke: `gh run list -w "RentCars push smoke" -L 1`.

## Publiczne repo

Wyniki (`output/`), sekrety i dane osobowe zostają poza commitami. Konfiguracja trafia do repo tylko jako `*.example.json`.
