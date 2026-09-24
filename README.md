# Scanner Boucherie

Traçabilité de la Boucherie Amiot.

- **Fichiers `*.html` à la racine** : ancienne version web (GitHub Pages, stockage Google Drive).
- **`www/` + `android/`** : app Android pour la tablette (Capacitor), 100 % hors ligne.
  - Données stockées sur la tablette, sauvegarde ZIP quotidienne dans `Téléchargements/ScannerBoucherie`.
  - Douchette Bluetooth captée sur tous les écrans ; quand elle se connecte, l'app passe au premier plan.
  - Import des anciennes données : ZIP du dossier Drive « Scanner Boucherie » (Réglages → Importer).

## Commandes

```sh
npm install
npm test        # parcours principaux dans jsdom
npm run apk     # cap sync + gradlew assembleDebug
```
