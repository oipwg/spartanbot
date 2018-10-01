import RentalProvider from "./RentalProvider";
import NiceHash from 'nicehash-api'

class NiceHashProvider extends RentalProvider {
	constructor(settings) {
		super(settings)

		this.api = new NiceHash(settings.key, settings.id)
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "NiceHash"
	 * @static
	 */
	static getType(){
		return "NiceHash"
	}
}

export default NiceHashProvider