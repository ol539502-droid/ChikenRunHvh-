import { renderConfigsPanel } from '../../panels/configs';
import { exportConfig, importConfig, sanitizeConfig } from '../config';
import type { Dev } from '../Dev';

export const configsPanel = (dev: Dev) => renderConfigsPanel(dev, { sanitizeConfig, importConfig, exportConfig });
