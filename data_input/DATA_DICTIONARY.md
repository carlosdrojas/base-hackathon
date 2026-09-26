# Synthetic Base Core inverter telemetry

**This is simulated.** It is not Base production data, not a real CAN dump, and not a real customer fleet.
Shaped for the Base × AITX hackathon Field RCA / auto-triage demo: ~39.2 kWh pack, ~20 kW inverter, Texas sites.

Goal of the schema: distinguish *install miss* (fan never installed) from *dead fan*, *hot garage*, and *actually-bad silicon* so healthy hardware is not pulled.

## How to use

1. `inventory.csv` — fleet input (`VIN`, location, `faulted`, `fault_time_utc`).
2. `events.csv` — detector outputs. Feed the agent these, not the full 1 Hz file.
3. `telemetry_1hz.csv.gz` — analog window around the fault (pointer target).
4. `packet_at_fault_time.csv` — one decoded packet per unit at `fault_time`, plus the comparison columns below. Nine `fixture_*` rows at the bottom are added detector cases. They are not inventory units.
5. `fw_allowlist.json` — signed firmware versions for this file. Every original inventory `fw_rev` is on it. `core-inv-3.3.0` is not.
6. `raw_packet_uri` on inventory is a fake pointer (`pointer://fw-log/...`). Do not invent a binary parser.

`do_not_return_hardware=Y` means the recommended action is *not* an inverter/pack RMA.

## Scenarios (ground truth)

| scenario | what happened | recommended_action |
|---|---|---|
| normal | healthy dispatch | none |
| hot_site_derate_ok | garage 42 °C, fans spinning, thermal derate | L1_site_vent_no_pull |
| fan_never_installed | BOM expects 2 fans, enum saw 0, RPM=0, current=0, PWM high, overtemp | L2_install_missing_fan |
| fan_stalled | RPM≈0, fan current high | L3_replace_fan |
| fan_unplugged | RPM=0, current≈0, but commission saw fans | L2_reseat_fan_harness |
| intake_restricted | fans spinning, ΔT heatsink−intake large, clearance_ok=false | L1_clear_intake |
| igbt_module_fault | IGBT A ≫ B/C | L4_pull_inverter |
| sensor_implausible | heatsink NTC pegs with near-zero power | L3_replace_ntc_do_not_pull_stack |
| healthy_false_alarm | 60 s bogus OVER_TEMP, rest healthy | L0_suppress_false_page |
| ct_reversed | AC current sign flipped | L2_fix_ct_orientation |
| comms_stale | gateway dies mid-window, packet age climbs | L0_no_truck_debug_gateway |
| cell_gradient | cell spread > 8 °C | L4_pull_pack_module |

## inventory.csv

| column | meaning |
|---|---|
| vin | fake Core serial `BP-CORE-#####-##` |
| city, state, lat, lon, load_zone | ERCOT-ish site |
| site_type | garage / patio / side_yard / interior_utility |
| faulted | Y/N (some Y are false pages) |
| fault_time_utc | when to open the ± window |
| scenario | ground-truth label (hide this from the agent if you want a blind demo) |
| recommended_action | L0–L4 gameplan |
| do_not_return_hardware | Y if pulling the box is the wrong move |
| expected_fan_count / observed_fan_count | commission vs first-boot enum |
| fan_present_0/1 | harness sense at commission |
| clearance_ok | install checklist |
| ct_orientation | correct / reversed |
| raw_packet_uri | pointer only |

## telemetry_1hz.csv.gz

1 Hz, 2 hours per VIN, 48 units.

Electrical: `p_cmd_w`, `p_ac_w`, `q_ac_var`, `tracking_err_w`, `soc`, `v_pack_v`, `i_pack_a`, `v_dc_link_v`, `v_a/b/c_v`, `i_a/b/c_a`, `hz`, `thd_pct`.

Thermal chain: `t_ambient_c`, `t_intake_c`, `t_exhaust_c`, `t_cabinet_c`, `t_heatsink_c`, `t_board_c`, `t_magnetics_c`, `t_igbt_a/b/c_c`, `t_cell_min/mean/max_c`, `t_cell_spread_c`, `delta_t_heatsink_intake_c`.

Fans: `fan_pwm_0/1`, `fan_rpm_0/1`, `fan_current_0/1_a`, `fan_fault_0/1`.

Protection: `thermal_derate_pct`, `op_state` (4 producing, 5 throttled, 7 fault — SunSpec-ish), `islanded`, `export_blocked`.

Detector bits (also rolled up into `events.csv`): `evt_over_temp`, `evt_fan_missing`, `evt_fan_stall`, `evt_fan_unplugged`, `evt_intake_restricted`, `evt_hot_site`, `evt_igbt_gradient`, `evt_sensor_implausible`, `evt_cell_gradient`, `evt_ct_reversed`, `evt_comms_stale`.

Comms: `last_pkt_age_ms`, `gateway_online`.

Sign convention: `p_ac_w` > 0 is discharge / export toward the home+grid; < 0 is charge.

## Detector columns on packet_at_fault_time.csv

Appended so `runDetectors` can be run from this file. Original analog columns are unchanged.

Copied from `inventory.csv`: `fw_version`, `hw_rev`, `faulted`.

Computed from measurements already on the row:

- `line_voltage_v` is `min(v_a_v, v_b_v)`. `v_c_v` is about 2 V on every unit, including healthy ones, and is not used.
- `grid_voltage_outside_window` / `grid_freq_outside_window` use the detector windows (211–264 V, 59.3–60.5 Hz).
- `cell_overtemp_trip` is the manual rule: cell temp above 65 °C and pack current above 0.5 A. None of the original rows trip it.
- `overtemp_signature` copies `evt_over_temp`. A 1 clamps the case to L0 even when the 65 °C rule is false (`healthy_false_alarm`).
- `ct_polarity_reversed` copies `evt_ct_reversed`.
- `checklist_complete` is N when `clearance_ok` is false or the observed fan count does not match the BOM.
- `first_boot_self_test_pass` is N when the fan counts disagree.
- `gateway_offline` is Y when `gateway_online` is 0.
- `fw_on_signed_manifest` is the allow-list comparison.

CAN counters, boot reason, house load, and playbook flags were not in the original snapshot. On the 48 inventory rows they are filled as "no extra signature" (zeros, `power_on`, playbooks not done). The `fixture_*` rows are where those comparisons are actually planted. `expected_root_cause`, `expected_level`, and `expected_action` are the answer key for `npm test`.

## RCA cheat for fan-never-installed

Expect together:

- `observed_fan_count = 0` and `expected_fan_count = 2`
- `fan_rpm_* = 0`, `fan_current_* ≈ 0`, `fan_pwm_*` high
- `evt_over_temp` + rising `t_heatsink_c`
- `t_igbt_a ≈ t_igbt_b ≈ t_igbt_c` (not a module)
- `t_cell_spread_c` small
- `t_ambient_c` not insane

That is an L2 install fix, not an L4 pull. On this fault-time packet, `evt_over_temp` is also 1, so the step-1 detectors clamp the row to L0. The incomplete fan checklist stays a differential.
