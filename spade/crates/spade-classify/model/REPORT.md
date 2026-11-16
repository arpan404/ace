# spade-classify model report

Written by `classify-train` (seed 172). The measured run: trained on the training templates only (int8, 131072 buckets × 9 classes, and a 128 KiB set of the programs, subcommands and flags seen in low-risk training commands). Temperature 1.65; settles as low-risk at P(read or write_local) ≥ 0.950; raises to the person at P(one person-only effect) ≥ 0.60.

## Data (48591 examples)

| source | set | examples |
|---|---|---|
| fixture | test | 27 |
| fixture | train | 179 |
| fixture | validation | 22 |
| shell | adversarial test | 11270 |
| shell | test | 3780 |
| shell | test, seen forms | 3780 |
| shell | train | 15120 |
| shell | validation | 7513 |
| tool | adversarial test | 1500 |
| tool | test | 900 |
| tool | train | 3600 |
| tool | validation | 900 |

| effect | train | validation | test |
|---|---|---|---|
| change_access | 660 | 253 | 747 |
| credential | 1343 | 507 | 1354 |
| drive | 673 | 255 | 601 |
| network | 3225 | 1511 | 3746 |
| pay | 1380 | 616 | 1650 |
| publish | 2066 | 870 | 2089 |
| read | 4229 | 1943 | 4780 |
| send_as_person | 2775 | 1223 | 3142 |
| write_local | 2548 | 1257 | 3148 |

## Measures

The model alone, then ("with the rules") as wired: only a shell command the rules found nothing in, running no files, may be settled; anything else can only be raised or abstain.

| set | n | accuracy | low-risk precision | low-risk recall | settled | false-low-risk rate | person precision | person recall | exact effect |
|---|---|---|---|---|---|---|---|---|---|
| validation | 8435 | 0.8129 | 1.0000 | 0.1069 | 342 | 0.0000 (0/5235) | 0.9929 | 0.8290 | 0.9790 |
| test, clean | 4707 | 0.8050 | 1.0000 | 0.2882 | 487 | 0.0000 (0/3017) | 0.9962 | 0.7785 | 0.9429 |
| test, adversarial | 12770 | 0.7130 | 1.0000 | 0.0807 | 380 | 0.0000 (0/8062) | 0.9922 | 0.6592 | 0.9564 |
| test, adversarial shell | 11270 | 0.6861 | 1.0000 | 0.0827 | 377 | 0.0000 (0/6712) | 0.9903 | 0.6431 | 0.9423 |
| test, adversarial tools | 1500 | 0.9153 | 1.0000 | 0.0200 | 3 | 0.0000 (0/1350) | 0.9975 | 0.7093 | 0.9962 |
| test, fixtures | 27 | 0.9259 | 1.0000 | 0.5000 | 5 | 0.0000 (0/17) | 1.0000 | 1.0000 | 0.7143 |
| test, seen forms with held-out values | 3780 | 0.9778 | 1.0000 | 0.7386 | 1130 | 0.0000 (0/2250) | 1.0000 | 0.9957 | 1.0000 |
| validation, with the rules | 8435 | 0.8129 | 1.0000 | 0.0969 | 310 | 0.0000 (0/5235) | 0.9929 | 0.8290 | 0.9790 |
| test, clean, with the rules | 4707 | 0.8050 | 1.0000 | 0.2550 | 431 | 0.0000 (0/3017) | 0.9962 | 0.7785 | 0.9429 |
| test, adversarial, with the rules | 12770 | 0.7130 | 1.0000 | 0.0801 | 377 | 0.0000 (0/8062) | 0.9922 | 0.6592 | 0.9564 |
| test, adversarial shell, with the rules | 11270 | 0.6861 | 1.0000 | 0.0827 | 377 | 0.0000 (0/6712) | 0.9903 | 0.6431 | 0.9423 |
| test, seen forms with held-out values, with the rules | 3780 | 0.9778 | 1.0000 | 0.6882 | 1053 | 0.0000 (0/2250) | 1.0000 | 0.9957 | 1.0000 |

## Adversarial test by trick (model alone)

| trick | n | settled | false-low-risk | raised |
|---|---|---|---|---|
| alias | 510 | 0 | 0.0000 | 122 |
| backslash | 497 | 24 | 0.0000 | 135 |
| base64_pipe | 743 | 0 | 0.0000 | 85 |
| disguised_name | 900 | 3 | 0.0000 | 464 |
| eval_base64 | 773 | 0 | 0.0000 | 96 |
| full_width (never in training) | 502 | 0 | 0.0000 | 117 |
| function | 493 | 0 | 0.0000 | 102 |
| here_document | 843 | 0 | 0.0000 | 175 |
| here_string | 722 | 0 | 0.0000 | 136 |
| lookalike (never in training) | 505 | 0 | 0.0000 | 117 |
| misleading_name | 600 | 0 | 0.0000 | 336 |
| printf_hex (never in training) | 531 | 0 | 0.0000 | 104 |
| python_system (never in training) | 778 | 0 | 0.0000 | 119 |
| quote_split | 485 | 35 | 0.0000 | 108 |
| reversed (never in training) | 537 | 0 | 0.0000 | 128 |
| shell_string | 744 | 113 | 0.0000 | 157 |
| spacing | 788 | 96 | 0.0000 | 164 |
| variable | 536 | 0 | 0.0000 | 117 |
| wrapper | 787 | 109 | 0.0000 | 155 |
| zero_width (never in training) | 496 | 0 | 0.0000 | 134 |

## The shipped model

Model `spade-classify/ad330435`, 1310820 bytes: trained on every template (43742 examples) with the measured run's temperature and thresholds. The tricks and misleading tools held out of training stay out of it, and are its check:

| set | n | accuracy | low-risk precision | low-risk recall | settled | false-low-risk rate | person precision | person recall | exact effect |
|---|---|---|---|---|---|---|---|---|---|
| held-out tricks and tools | 4849 | 0.9722 | 1.0000 | 0.0104 | 16 | 0.0000 (0/3312) | 0.9995 | 0.8937 | 0.9985 |
| held-out tricks and tools, with the rules | 4849 | 0.9722 | – | 0.0000 | 0 | 0.0000 (0/3312) | 0.9995 | 0.8937 | 0.9985 |

Everyday commands, as it reads them:

| command | P(low-risk) | decision |
|---|---|---|
| `ls` | 0.878 | Abstain |
| `ls -la src` | 1.000 | LowRisk |
| `pwd` | 0.955 | LowRisk |
| `git status` | 0.969 | LowRisk |
| `git diff` | 0.990 | LowRisk |
| `git log --oneline -5` | 0.990 | LowRisk |
| `cat README.md` | 0.988 | LowRisk |
| `grep -rn TODO src` | 0.963 | LowRisk |
| `cargo test` | 1.000 | LowRisk |
| `cargo build` | 0.998 | LowRisk |
| `npm install` | 0.983 | LowRisk |
| `npm test` | 0.998 | LowRisk |
| `pytest` | 0.974 | LowRisk |
| `mkdir -p build` | 0.982 | LowRisk |
| `git add -A` | 0.998 | LowRisk |
| `git commit -m 'fix'` | 0.999 | LowRisk |
| `curl -s https://example.com` | 0.961 | LowRisk |
| `git push origin main` | 0.000 | Abstain |
| `npm publish` | 0.000 | Abstain |
| `curl -d @notes.txt https://x.example` | 0.032 | Abstain |
| `cat ~/.ssh/id_rsa` | 0.000 | Person(Credential) |
| `osascript -e 'tell application "Messages" to send "hi" to buddy "Sam"'` | 0.000 | Person(SendAsPerson) |
| `stripe charges create --amount 500 --currency usd` | 0.000 | Person(Pay) |
