// Entry point for the combined CET assistant. The shell owns tab navigation,
// the shared toast / service-status helpers and the health probe; the reading
// tutor and score estimator are self-contained feature modules that mount into
// their own views. Import order matters: shell first, then the feature modules.
import { initShell } from './shell.js';
import './lab.js';
import './reading.js';
import './estimator.js';

initShell();