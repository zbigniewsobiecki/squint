Rails.application.routes.draw do
  namespace :api do
    resources :books, only: [:index, :show, :create, :update, :destroy] do
      member do
        post :restock
      end
    end

    resources :orders, only: [:index, :show, :create]
    resources :sessions, only: [:create, :destroy]
  end
end
