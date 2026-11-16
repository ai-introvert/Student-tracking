import React, { useCallback, useState } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';
import { Search, Loader2, MapPin, X } from 'lucide-react';
import {
  triggerQuotaNoticeIfNeeded,
  useAutocompleteSuggestions,
} from '../hooks/useAutocompleteSuggestions';
import { LatLngPoint } from '../types/wayhome';

export interface SelectedPlaceResult {
  name: string;
  address: string;
  location: LatLngPoint;
}

interface PlaceSearchInputProps {
  placeholder: string;
  label?: string;
  initialValue?: string;
  onSelect: (result: SelectedPlaceResult) => void;
}

export const PlaceSearchInput: React.FC<PlaceSearchInputProps> = ({
  placeholder,
  label,
  initialValue = '',
  onSelect,
}) => {
  const placesLib = useMapsLibrary('places');
  const [query, setQuery] = useState(initialValue);
  const [isOpen, setIsOpen] = useState(false);
  const [isFetchingDetails, setIsFetchingDetails] = useState(false);
  const { suggestions, isLoading, error, resetSession } = useAutocompleteSuggestions(query);

  const handleSelectSuggestion = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!placesLib || !suggestion.placePrediction) return;
      setIsFetchingDetails(true);
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['displayName', 'formattedAddress', 'location'],
        });
        const loc = place.location;
        if (loc) {
          const displayName = place.displayName || suggestion.placePrediction.text.text || 'Selected Location';
          const formattedAddress = place.formattedAddress || suggestion.placePrediction.text.text || '';
          onSelect({
            name: displayName,
            address: formattedAddress,
            location: { lat: loc.lat(), lng: loc.lng() },
          });
          setQuery(formattedAddress || displayName);
        }
        setIsOpen(false);
        resetSession();
      } catch (err) {
        triggerQuotaNoticeIfNeeded(err);
      } finally {
        setIsFetchingDetails(false);
      }
    },
    [placesLib, onSelect, resetSession]
  );

  return (
    <div className="relative w-full">
      {label && (
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          className="w-full min-h-[44px] pl-9 pr-9 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700 transition-colors"
        />
        {(isLoading || isFetchingDetails) ? (
          <Loader2 className="w-4 h-4 text-blue-700 animate-spin absolute right-3" />
        ) : query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              resetSession();
            }}
            aria-label="Clear search"
            className="absolute right-1.5 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-slate-700 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        ) : null}
      </div>

      {error && (
        <p className="mt-1.5 text-xs text-amber-700">{error}</p>
      )}

      {isOpen && suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1.5 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto divide-y divide-slate-100">
          {suggestions.map((suggestion, idx) => {
            const text = suggestion.placePrediction?.text.text || 'Location';
            return (
              <li key={idx}>
                <button
                  type="button"
                  onClick={() => void handleSelectSuggestion(suggestion)}
                  className="w-full text-left px-3.5 py-2.5 min-h-[44px] flex items-start gap-2.5 hover:bg-slate-50 transition-colors"
                >
                  <MapPin className="w-4 h-4 text-blue-700 mt-0.5 shrink-0" />
                  <span className="text-sm text-slate-800 leading-snug">{text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
