import rawMap from '../../data/map.json';
import { loadMap } from './loadMap';

/** 기본 가상 단지. 모듈 로드 시 한 번 검증한다 */
export const defaultMap = loadMap(rawMap);
